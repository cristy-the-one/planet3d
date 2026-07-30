# VSS Mapping Toolkit — Development Map

**Status:** design, revision 2
**Audience:** an agentic builder (AI/LLM) implementing the toolkit unit by unit, plus human reviewers of the resulting PRs.

The system is decomposed into **8 units** plus a set of **cross-cutting contracts** (§0). Each unit is designed so it can be implemented, tested, and replaced independently.

**Guiding rules for every unit**

- Clear reason-to-exist.
- Explicit architectural plan.
- Strict public interfaces — data contracts *and* behavioural contracts.
- Dependencies flow downward only, and that rule is **machine-enforced** (§0.2).
- All deep features are reachable through the public interface; no hidden magic.
- A unit is not done until its **conformance suite** passes (§0.6) and its **definition of done** is met.

---

## §0 Cross-cutting contracts

These exist because "each unit is independently replaceable" is a claim that only holds if something enforces it. This section is the enforcement.

### 0.1 Package layout

```
vss_mapping/
  core/            # Unit 1: models, errors, provenance. Imports nothing from vss_mapping.
  ingest/          # Unit 2
  knowledge/       # Unit 3 (incl. UnitRegistry)
  suggest/         # Unit 4
  store/           # Unit 5
  generate/        # Unit 6
  validate/        # Unit 7
  orchestrate/     # Unit 8
  cli/             # consumer — may import only orchestrate + core
tests/
  conformance/     # protocol-level suites, parameterised over implementations
  unit/
  fixtures/        # synthetic DBC/vspec only — see §0.8
```

### 0.2 Dependency rule

Allowed import edges (a unit may import from anything strictly below it):

```
cli → orchestrate → {ingest, knowledge, suggest, store, validate, generate} → core
suggest → knowledge          (needs the catalog + UnitRegistry)
validate → knowledge         (needs the catalog + UnitRegistry)
generate → core only
ingest   → core only
store    → core only
```

Everything else is forbidden — in particular `knowledge` must not import `suggest`, and no unit other than `orchestrate` may import a sibling not listed above. Enforce with [`import-linter`](https://import-linter.readthedocs.io/) in CI:

```ini
# setup.cfg
[importlinter]
root_package = vss_mapping

[importlinter:contract:layers]
name = Unit layering
type = layers
layers =
    vss_mapping.cli
    vss_mapping.orchestrate
    vss_mapping.suggest : vss_mapping.validate
    vss_mapping.knowledge : vss_mapping.ingest : vss_mapping.store : vss_mapping.generate
    vss_mapping.core
```

A layering violation is a build failure, not a review comment.

### 0.3 Error taxonomy

Protocols that can fail must say how. Defined once, in `core/errors.py`:

```python
class VSSMappingError(Exception):
    """Base for everything this toolkit raises."""

class SourceParseError(VSSMappingError):
    """Source artefact is malformed or unsupported. Carries file + locus."""
    def __init__(self, message: str, *, path: str | None = None, locus: str | None = None): ...

class UnsupportedSourceError(SourceParseError):
    """No registered ingester claimed the input."""

class KnowledgeBaseNotLoadedError(VSSMappingError): ...
class UnknownVSSPathError(VSSMappingError): ...
class UnitConversionError(VSSMappingError): ...
class SessionNotFoundError(VSSMappingError): ...
class ConcurrentModificationError(VSSMappingError):
    """Optimistic-lock failure in MappingStore."""
class ArtifactGenerationError(VSSMappingError): ...
```

Rules: no unit raises bare `Exception`/`ValueError` across a public boundary; suggestion and validation **never** raise on a merely low-quality signal — a bad signal produces a low-confidence suggestion or a `ValidationIssue`, not a traceback.

### 0.4 Provenance and reproducibility

Every artefact the toolkit emits must be re-derivable. A `Provenance` block (defined in Unit 1) is attached to every session and embedded in every generated artefact: toolkit version, VSS catalog version + content hash, ingester name + version, source file hash, suggestion strategy identifiers + model/embedding identifiers, UTC timestamp.

Without this, a mapping document six months old is unauditable.

### 0.5 Determinism policy

"Deterministic at `temperature=0`" is not a property LLMs have. The contract is instead:

1. **Ordering is total.** Suggestions are sorted by `(-confidence, target.path)` — never by dict iteration order — so equal scores tie-break stably.
2. **Rule and embedding strategies are byte-deterministic** given the same catalog hash and model identifier. Tested as such.
3. **LLM/RAG strategies are cached**, keyed by `sha256(prompt + model_id + params)`, and declare `deterministic = False`. Re-running a session with a warm cache reproduces prior output exactly; this is how CI stays stable.
4. Floating-point confidences are rounded to 4 decimal places before comparison and serialisation.

### 0.6 Conformance suites (the mechanism that makes units replaceable)

For every unit defined by a Protocol, `tests/conformance/` holds a suite parameterised over implementations:

```python
# tests/conformance/test_source_ingester.py
@pytest.fixture(params=[DBCIngestor, FakeIngestor])
def ingester(request) -> SourceIngester: ...

def test_ingest_is_pure(ingester, fixture_path):
    """Two ingests of the same input produce equal signals, including ids."""

def test_ids_are_stable_across_processes(ingester, fixture_path): ...
def test_no_matching_performed(ingester, fixture_path):
    """Every returned signal has no target and no transformation."""
def test_unparseable_input_raises_source_parse_error(ingester): ...
```

A new implementation of a unit is accepted when it passes that unit's suite unchanged. Adding an implementation must never require editing the suite.

### 0.7 Definition of done (template, applied per unit)

1. Public interface matches this document, or this document was updated in the same PR.
2. Conformance suite green; unit tests ≥ 90 % branch coverage on the unit's own package.
3. `import-linter` green.
4. `mypy --strict` green on the unit's package.
5. Public symbols have docstrings stating raised exceptions and mutation behaviour.
6. Unit-specific acceptance criteria (listed under each unit below) met.

### 0.8 Legal and data-handling notes

- The VSS catalog is Mozilla Public License 2.0; VSSo is under COVESA terms. Record the licence of any vendored catalog copy.
- **Customer DBC/ARXML files are routinely confidential.** No real OEM source file enters the repository, test fixtures, CI logs, or an LLM prompt without explicit written clearance. Fixtures are hand-written synthetic DBCs.
- If a strategy sends signal names or descriptions to a hosted model, that is a data-egress decision: it must be opt-in per session, recorded in `Provenance`, and disable-able by config.

---

## Unit 1: CoreSignalModel

### Reason-to-exist

The single source of truth for how a signal is represented inside the toolkit. Without one rich intermediate model, every other unit invents a slightly different notion of "a signal", and integrations become brittle and lossy.

### Architectural plan

- Pure data layer: no business logic, no I/O, no imports from other units.
- Pydantic v2 for every structure, `model_config = ConfigDict(extra="forbid")`.
- **Two models, not one.** The original single `IntermediateSignal` mixed immutable source facts with mutable workflow state, which meant the "pure data layer" also owned the review lifecycle that Unit 5 is supposed to own. Split:
  - `SourceSignal` — frozen. What the ingester found. Never edited downstream.
  - `MappingRecord` — mutable workflow state, referencing a `SourceSignal` by id.
- Support source-side richness (message id, bit position, cycle time) *and* target-side VSS concepts (path, datatype, unit, instance qualifiers).
- Support **non-1:1 cardinality**: one CAN signal can feed several VSS paths (a packed status byte), and one VSS path can require several CAN signals (a value + a validity bit). A single `Optional[VSSTargetRef]` cannot express either.
- Transformations are a **closed, structured union**, not a free-text expression to `eval()`. See the note below — this is a security boundary as much as a design one.
- JSON-serialisable and versioned.

### Interfaces

```python
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = "1.0.0"


class Provenance(BaseModel):
    """See §0.4. Embedded in sessions and generated artefacts."""
    model_config = ConfigDict(extra="forbid", frozen=True)

    toolkit_version: str
    vss_version: str
    vss_catalog_sha256: str
    ingester: Optional[str] = None          # "DBCIngestor/1.2.0"
    source_sha256: Optional[str] = None
    strategies: list[str] = Field(default_factory=list)  # ["rule/1.0", "embedding/bge-m3"]
    created_at: datetime
    llm_egress: bool = False                # True if signal text left the machine


# ---------- source side ----------

class SourceSignalMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    source_format: Literal["dbc", "arxml", "fibex", "someip", "custom"]
    signal_name: str
    message_id: Optional[str] = None        # canonical hex, e.g. "0x1A0" — see validator
    message_name: Optional[str] = None
    start_bit: Optional[int] = Field(default=None, ge=0)
    length: Optional[int] = Field(default=None, ge=1)
    byte_order: Optional[Literal["little", "big"]] = None
    is_signed: Optional[bool] = None        # was missing; changes decoded value entirely
    is_float: Optional[bool] = None
    factor: Optional[float] = None
    offset: Optional[float] = None
    unit: Optional[str] = None              # raw source unit string, uninterpreted
    min: Optional[float] = None
    max: Optional[float] = None
    cycle_time_ms: Optional[float] = Field(default=None, gt=0)
    sender: Optional[str] = None
    receivers: list[str] = Field(default_factory=list)
    description: Optional[str] = None
    allowed_values: dict[str, str] = Field(default_factory=dict)  # raw value -> label
    multiplexor: Optional[str] = None       # multiplexed frames are common and were unmodelled
    multiplex_value: Optional[int] = None
    raw_extra: dict[str, Any] = Field(default_factory=dict)       # format-specific escape hatch

    @field_validator("message_id")
    @classmethod
    def _canonical_hex(cls, v: str | None) -> str | None:
        """Normalise to lowercase 0x form so ids hash consistently across ingesters."""
        ...

    @model_validator(mode="after")
    def _min_le_max(self) -> SourceSignalMetadata: ...


class SourceSignal(BaseModel):
    """Immutable. Produced only by Unit 2."""
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str                                 # deterministic — see signal_id()
    source_id: str                          # which ingested artefact this came from
    metadata: SourceSignalMetadata


def signal_id(source_id: str, md: SourceSignalMetadata) -> str:
    """Deterministic content hash: sha256(source_id|format|message_id|signal_name|mux)[:16].

    MUST NOT be a random UUID. Re-ingesting the same DBC has to yield the same
    ids, or sessions cannot be refreshed, diffed, or resumed after a source bump.
    """
```

```python
# ---------- target side ----------

class VSSTargetRef(BaseModel):
    """A reference to a VSS node. Used both for proposals and accepted mappings
    (the original 'VSSTargetHint' name implied it was only ever a guess)."""
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str                               # "Vehicle.Speed"
    datatype: Optional[str] = None          # VSS datatype token, e.g. "float", "uint8"
    unit: Optional[str] = None              # VSS unit id, e.g. "km/h"
    type: Optional[Literal["sensor", "actuator", "attribute", "branch"]] = None
    instance_qualifiers: list[str] = Field(default_factory=list)
    # e.g. ["Row1", "DriverSide"] for Vehicle.Cabin.Door.Row1.DriverSide.IsOpen
    exists_in_catalog: bool = True          # False => this mapping needs a new node in the overlay
    vss_version: Optional[str] = None       # which catalog this ref was resolved against


# ---------- transformations ----------

class LinearTransform(BaseModel):
    """raw -> factor * raw + offset, then optional unit conversion. Covers the
    overwhelming majority of real DBC signals."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["linear"] = "linear"
    factor: float = 1.0
    offset: float = 0.0
    from_unit: Optional[str] = None
    to_unit: Optional[str] = None


class EnumTransform(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["enum"] = "enum"
    value_map: dict[str, Any]               # raw value (as str) -> VSS value
    default: Optional[Any] = None
    unmapped: Literal["error", "default", "passthrough"] = "error"


class BoolTransform(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["bool"] = "bool"
    true_values: list[str]
    invert: bool = False


class ExpressionTransform(BaseModel):
    """Escape hatch for genuinely nonlinear cases (e.g. thermistor curves).

    `expression` is NOT Python and is NOT eval()'d. It is parsed against a
    restricted grammar: numeric literals, the identifier `x`, + - * / **,
    parentheses, and the whitelisted functions in ALLOWED_FUNCS. Anything else
    is a validation error at construction time. Never accept this field from an
    LLM without re-parsing it.
    """
    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["expression"] = "expression"
    expression: str                         # "min(100.0, 0.0625 * x - 40.0)"
    from_unit: Optional[str] = None
    to_unit: Optional[str] = None

    @field_validator("expression")
    @classmethod
    def _parse_only_safe_ast(cls, v: str) -> str: ...


TransformationSpec = Annotated[
    Union[LinearTransform, EnumTransform, BoolTransform, ExpressionTransform],
    Field(discriminator="kind"),
]
```

```python
# ---------- workflow side ----------

class MappingCandidate(BaseModel):
    """A proposed target. Produced by Unit 4, stored by Unit 5."""
    model_config = ConfigDict(extra="forbid", frozen=True)

    target: VSSTargetRef
    confidence: float = Field(ge=0.0, le=1.0)
    explanation: str
    strategy: str                           # "rule/1.0", "embedding/bge-m3", "hybrid/2.0"
    deterministic: bool = True              # see §0.5
    transformation: Optional[TransformationSpec] = None


class AcceptedMapping(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    target: VSSTargetRef
    transformation: Optional[TransformationSpec] = None
    contributing_signal_ids: list[str] = Field(default_factory=list)
    # non-empty when several source signals combine into one VSS value


class MappingRecord(BaseModel):
    """Mutable workflow state for one source signal. Owned by Unit 5."""
    model_config = ConfigDict(extra="forbid")

    signal_id: str
    status: Literal["raw", "suggested", "accepted", "rejected", "needs_review"] = "raw"
    candidates: list[MappingCandidate] = Field(default_factory=list)
    accepted: list[AcceptedMapping] = Field(default_factory=list)  # list => 1:N supported
    tags: list[str] = Field(default_factory=list)
    revision: int = 1                       # optimistic-lock token, bumped per decision
    schema_version: str = SCHEMA_VERSION

    @model_validator(mode="after")
    def _status_matches_content(self) -> MappingRecord:
        """accepted status requires >=1 accepted mapping; rejected requires none."""
        ...
```

> **Migration note.** Revision 1 of this document used a single `IntermediateSignal` carrying `proposed_targets`, `accepted_target`, `confidence`, `explanation`, and `status`. That model appears in no shipped code yet, so replace it outright rather than aliasing. Where downstream units previously took `list[IntermediateSignal]`, they now take `list[SourceSignal]` and/or `list[MappingRecord]` — spelled out per unit below.

### Acceptance criteria

- Round-trip property test: `Model.model_validate_json(m.model_dump_json()) == m` for every model, over Hypothesis-generated instances.
- `signal_id()` is stable across processes and Python versions (`PYTHONHASHSEED` varied in CI).
- `ExpressionTransform` rejects, with a test each: `__import__`, attribute access, function calls not in the whitelist, walrus/lambda/comprehension, and names other than `x`.
- Zero imports from any other `vss_mapping` package (asserted by test, not just by lint).

---

## Unit 2: SourceIngester

### Reason-to-exist

DBC, ARXML, FIBEX, and Excel dumps must be normalised into the core model without leaking format-specific complexity anywhere else. All parsing lives here.

### Architectural plan

- Protocol first; `DBCIngestor` as the first concrete implementation (highest value, best tooling — `cantools`).
- New formats are added by implementing the Protocol; nothing above changes.
- A **registry** resolves input → ingester via `can_handle`. Unit 8 must accept the registry rather than a single ingester, otherwise multi-format support exists in the type system but not in the pipeline.
- Preserve every scrap of original metadata; anything the model has no field for goes to `raw_extra` rather than being dropped.
- `ingest` is pure with respect to the toolkit: it performs **no** matching, scoring, or transformation. It may read the filesystem.

### Interfaces

```python
from pathlib import Path
from typing import Protocol, runtime_checkable

SourceInput = Union[str, Path, bytes]


@runtime_checkable
class SourceIngester(Protocol):
    name: str                               # "DBCIngestor"
    version: str                            # "1.2.0" — lands in Provenance

    def can_handle(self, source: SourceInput) -> bool:
        """Cheap sniff test. Must not raise on garbage input — return False."""
        ...

    def ingest(self, source: SourceInput, source_id: str | None = None) -> IngestResult:
        """Parse and return signals in canonical order.

        Raises SourceParseError on malformed input. Never returns partial
        results silently: recoverable per-signal problems go into
        IngestResult.warnings.
        """
        ...


class IngestResult(BaseModel):
    """Return type is a result object, not a bare list, because a real DBC
    always produces warnings worth surfacing (unmapped multiplexors, duplicate
    signal names, missing units) and a bare list has nowhere to put them."""
    model_config = ConfigDict(extra="forbid")

    source_id: str
    source_sha256: str
    signals: list[SourceSignal]             # sorted by (message_id, start_bit, signal_name)
    warnings: list[str] = Field(default_factory=list)
    node_names: list[str] = Field(default_factory=list)
    raw_extra: dict[str, Any] = Field(default_factory=dict)


class IngesterRegistry:
    def register(self, ingester: SourceIngester) -> None: ...
    def resolve(self, source: SourceInput) -> SourceIngester:
        """First registered ingester whose can_handle returns True.
        Raises UnsupportedSourceError if none do."""
        ...
    def ingest(self, source: SourceInput, source_id: str | None = None) -> IngestResult: ...


class DBCIngestor:
    def __init__(self, strict: bool = True) -> None:
        """strict=True: any cantools parse diagnostic is fatal.
        strict=False: skip the offending message, record a warning, continue."""
        ...
    def can_handle(self, source: SourceInput) -> bool: ...
    def ingest(self, source: SourceInput, source_id: str | None = None) -> IngestResult: ...
```

### Acceptance criteria

- Parses a synthetic fixture DBC exercising: extended (29-bit) ids, big- and little-endian signals, signed and unsigned, float signals, multiplexed frames, `VAL_` enum tables, `SIG_VALTYPE_`, comments, and units.
- `strict=False` on a deliberately corrupted fixture yields signals from the intact messages plus a warning per skipped message.
- Byte-for-byte identical `IngestResult` (ids included) across two runs in separate processes.
- `can_handle` returns `False`, without raising, for: empty bytes, a PNG, an ARXML, and a truncated DBC.

---

## Unit 3: VSSKnowledgeBase

### Reason-to-exist

All matching needs fast, rich access to the official VSS catalog and the VSSo ontology, loaded once and searchable. Without a dedicated service, every matcher re-parses VSS files and each one drifts.

### Architectural plan

- Load the official VSS catalog — prefer the **released JSON export** as the primary path (`vss_release_<ver>.json`); `.vspec` source requires `vss-tools` and is the slower, optional path. Optionally overlay VSSo for ontology URIs.
- Two indexes: **lexical** (tokenised path + description, BM25 or rapidfuzz) and **semantic** (sentence-embedding vectors, persisted to disk keyed by catalog hash so start-up is cheap and offline-capable).
- Multiple VSS versions loadable side by side; every returned node knows its version.
- **Owns the `UnitRegistry`.** VSS ships `units.yaml`; unit compatibility and conversion are catalog knowledge, and both Unit 4 and Unit 7 need them. Putting it here keeps it below both and stops each from hand-rolling a `"kph" == "km/h"` table.
- Read-only after `load()`; safe to share across threads.

### Interfaces

```python
class VSSNode(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    type: Literal["branch", "sensor", "actuator", "attribute"]
    datatype: Optional[str] = None
    unit: Optional[str] = None
    description: Optional[str] = None
    comment: Optional[str] = None
    min: Optional[float] = None
    max: Optional[float] = None
    allowed: list[str] = Field(default_factory=list)   # VSS enum ("allowed" list)
    deprecation: Optional[str] = None                  # do not propose deprecated nodes
    instances: list[str] = Field(default_factory=list) # instance spec, e.g. ["Row[1,2]", ...]
    children: list[str] = Field(default_factory=list)
    vsso_uri: Optional[str] = None
    vss_version: str


class SearchFilters(BaseModel):
    """Typed, because `filters: dict` is unimplementable against a contract."""
    model_config = ConfigDict(extra="forbid")
    types: list[Literal["branch", "sensor", "actuator", "attribute"]] = Field(default_factory=list)
    unit: Optional[str] = None              # exact VSS unit id
    unit_compatible_with: Optional[str] = None  # any unit convertible to this one
    path_prefix: Optional[str] = None       # "Vehicle.Powertrain"
    datatype: Optional[str] = None
    include_deprecated: bool = False


class UnitRegistry(Protocol):
    def is_known(self, unit: str) -> bool: ...
    def normalise(self, unit: str) -> Optional[str]:
        """Map a source-side unit string to a VSS unit id ('kph' -> 'km/h').
        Returns None when unrecognised — never guesses."""
        ...
    def compatible(self, unit_a: str, unit_b: str) -> bool:
        """True iff same quantity kind (both speeds, both temperatures, ...)."""
        ...
    def conversion(self, from_unit: str, to_unit: str) -> LinearTransform:
        """Factor/offset carrying from_unit -> to_unit.
        Raises UnitConversionError if incompatible or unknown."""
        ...


class VSSKnowledgeBase(Protocol):
    @property
    def vss_version(self) -> str: ...
    @property
    def catalog_sha256(self) -> str: ...
    @property
    def units(self) -> UnitRegistry: ...

    def load(self, vss_version: str = "latest", *, catalog_path: Path | None = None) -> None:
        """Idempotent. 'latest' resolves against a pinned lockfile, not a live
        network call — a build must not change behaviour because upstream
        tagged a release. Raises SourceParseError on a bad catalog."""
        ...

    def get_by_path(self, path: str) -> Optional[VSSNode]: ...

    def resolve_instance_path(self, path: str) -> Optional[VSSNode]:
        """Resolve a concrete instantiated path such as
        'Vehicle.Cabin.Door.Row1.DriverSide.IsOpen' back to its template node."""
        ...

    def search(self, query: str, limit: int = 20,
               filters: SearchFilters | None = None) -> list[ScoredNode]:
        """Ranked (node, score) with score in [0, 1], sorted by (-score, path).
        Raises KnowledgeBaseNotLoadedError if load() has not run."""
        ...

    def get_all_paths(self) -> list[str]:
        """Sorted. Leaf and branch paths both included."""
        ...

    def get_unit_compatible(self, unit: str) -> list[VSSNode]: ...


class ScoredNode(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    node: VSSNode
    score: float = Field(ge=0.0, le=1.0)
    matched_on: Literal["path", "description", "unit", "semantic"] = "semantic"
```

### Acceptance criteria

- Loads a full recent VSS release (~1 000+ nodes) in < 2 s warm, and answers `search()` in < 50 ms p95 on a laptop CPU.
- Embedding index persists and reloads; a cold second run with no network succeeds.
- Two versions loaded concurrently return correctly version-tagged nodes for a path whose datatype changed between them.
- `UnitRegistry.conversion("km/h", "m/s")` and `("celsius", "kelvin")` (offset case) are exact to 1e-9; `("km/h", "kelvin")` raises.
- Deprecated nodes are excluded from `search()` by default and included with `include_deprecated=True`.

---

## Unit 4: SuggestionEngine

### Reason-to-exist

The intelligence core: turn a raw source signal into ranked, explained candidate mappings, combining rules, embeddings, and optionally RAG/LLM — while staying replaceable.

### Architectural plan

- Several strategies behind one Protocol, composed by a `HybridSuggester` that merges and re-ranks.
- Always return confidence **and** a short natural-language explanation. An unexplained suggestion is unreviewable, and human review is the whole point.
- Never mutates input. Returns `MappingCandidate` objects; the caller decides what to persist.
- **Batch API is the primary API.** A production DBC has 1 000–4 000 signals; per-signal embedding or LLM calls are 100× slower and dominate cost. `suggest_one` is a convenience wrapper over `suggest_batch`.
- KB injected via constructor, matching Unit 8's dependency-injection style, so call sites stay clean and a strategy can pre-build state at construction.
- Confidence is **calibrated, not raw cosine similarity** — see acceptance criteria. A raw dot product presented as "0.87 confidence" misleads reviewers into rubber-stamping.

### Interfaces

```python
class SuggestionContext(BaseModel):
    """Optional extras a strategy may exploit. Passing this explicitly keeps
    strategies pure and testable instead of reaching for global state."""
    model_config = ConfigDict(extra="forbid")
    source_id: Optional[str] = None
    sibling_signals: list[SourceSignal] = Field(default_factory=list)  # same message
    already_mapped: dict[str, str] = Field(default_factory=dict)       # signal_id -> vss path
    domain_hints: list[str] = Field(default_factory=list)              # ["powertrain", "adas"]
    allow_llm: bool = False                                            # data-egress gate, §0.8


class SuggestionEngine(Protocol):
    name: str                               # "hybrid/2.0" — lands in Provenance
    deterministic: bool

    def suggest_batch(self, signals: list[SourceSignal], top_k: int = 5,
                      context: SuggestionContext | None = None,
                      ) -> dict[str, list[MappingCandidate]]:
        """signal_id -> ranked candidates, sorted by (-confidence, target.path).

        Contracts:
          - Pure: no argument is mutated.
          - Returns a key for every input signal; an empty list is a valid answer
            and is preferable to a fabricated low-quality guess.
          - Every candidate's target.path either exists in the KB, or has
            exists_in_catalog=False and is explicitly proposed as a new node.
          - Determinism per §0.5.
          - Never raises for a hard-to-map signal.
        """
        ...

    def suggest_one(self, signal: SourceSignal, top_k: int = 5,
                    context: SuggestionContext | None = None) -> list[MappingCandidate]: ...


# Concrete strategies (each implements SuggestionEngine)

class RuleSuggester:
    """Deterministic heuristics: exact/normalised name match, known abbreviation
    table (VehSpd -> Vehicle.Speed), unit compatibility, message-name context."""
    def __init__(self, kb: VSSKnowledgeBase, abbreviations: dict[str, str] | None = None): ...

class EmbeddingSuggester:
    """Cosine similarity between an embedded signal descriptor and embedded VSS
    node descriptors, with calibrated score mapping."""
    def __init__(self, kb: VSSKnowledgeBase, model_id: str = "BAAI/bge-m3"): ...

class LLMSuggester:
    """RAG: retrieve top-N via kb.search, ask the model to choose and justify.
    Requires context.allow_llm=True; otherwise returns []. Output is re-validated
    against the KB — a hallucinated path is dropped, never emitted."""
    def __init__(self, kb: VSSKnowledgeBase, client: Any, cache: Any): ...

class HybridSuggester:
    """Merge candidates from several strategies; dedupe by path; combine scores
    with configured weights; agreement between independent strategies raises
    confidence, disagreement lowers it."""
    def __init__(self, strategies: list[SuggestionEngine], weights: dict[str, float] | None = None): ...
```

### Acceptance criteria

This unit is the one with no natural definition of done, so it gets an explicit one — **build the benchmark before the engine** (see the build order).

- A gold set of ≥ 100 hand-mapped synthetic DBC signals (`tests/fixtures/gold/`), spread across powertrain, body, ADAS, and HVAC, including ~10 signals with **no** correct VSS target.
- Reported metrics: top-1 accuracy, top-5 accuracy, MRR, and abstention rate on the no-target subset.
- Gate for merging `RuleSuggester` + `EmbeddingSuggester`: **top-5 ≥ 0.80, top-1 ≥ 0.55** on the gold set. `HybridSuggester` must beat the better single strategy on top-5 or it does not ship.
- **Calibration:** bucket candidates by reported confidence; within each 0.1 bucket the observed accuracy must be within ±0.15 of the bucket midpoint. This is what makes "review anything under 0.8" a usable workflow rule.
- Pure-strategy runs are byte-identical across repeats; LLM runs are identical with a warm cache.
- `LLMSuggester` is tested against a stub client that returns a hallucinated path, an out-of-range confidence, and malformed JSON — all three are handled without raising.

---

## Unit 5: MappingStore

### Reason-to-exist

Mappings evolve, need versioning, human approval, and audit history. This unit owns the lifecycle of accepted and rejected mappings so nothing else deals with persistence.

### Architectural plan

- A **mapping session** (project) is first-class: name, source, provenance, signals, records, decision log.
- Decisions are an **append-only log**; `MappingRecord` state is a *fold* of that log, never edited in place. That is what makes the audit history trustworthy rather than decorative.
- Implementations: `InMemoryMappingStore` (tests, default), `JSONFileMappingStore` (single-user, git-friendly), later SQL. All pass the same conformance suite.
- Optimistic concurrency via `MappingRecord.revision`, so a UI and a CLI cannot silently clobber each other.
- Typed export model, not a bare `dict` — an untyped snapshot cannot be validated on import.

### Interfaces

```python
class MappingDecision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    signal_id: str
    decision: Literal["accepted", "rejected", "needs_review"]
    mappings: list[AcceptedMapping] = Field(default_factory=list)  # required iff accepted
    reviewer: Optional[str] = None
    timestamp: datetime
    notes: Optional[str] = None
    expected_revision: Optional[int] = None   # optimistic lock; None = force
    from_candidate: Optional[str] = None      # strategy that produced the accepted target,
                                              # so acceptance rates per strategy are measurable

    @model_validator(mode="after")
    def _accepted_requires_mappings(self) -> MappingDecision: ...


class SessionSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: str = SCHEMA_VERSION
    session_id: str
    name: str
    source_id: str
    provenance: Provenance
    signals: list[SourceSignal]
    records: list[MappingRecord]
    decisions: list[MappingDecision]         # append-only, chronological


class MappingStore(Protocol):
    def create_session(self, name: str, source_id: str, provenance: Provenance) -> str: ...
    def list_sessions(self) -> list[SessionInfo]: ...
    def get_session(self, session_id: str) -> SessionSnapshot:
        """Raises SessionNotFoundError."""
        ...

    def add_signals(self, session_id: str, signals: list[SourceSignal]) -> None:
        """Idempotent by signal id: re-adding an existing signal updates its
        SourceSignal but preserves its MappingRecord and decision history.
        This is what lets a session survive a DBC revision."""
        ...

    def add_candidates(self, session_id: str,
                       candidates: dict[str, list[MappingCandidate]]) -> None:
        """Attach suggestions; moves 'raw' records to 'suggested'.
        Replaces prior candidates from the same strategy, keeps others."""
        ...

    def record_decision(self, session_id: str, decision: MappingDecision) -> MappingRecord:
        """Append to the log and return the resulting record.
        Raises ConcurrentModificationError if expected_revision is stale."""
        ...

    def get_signal(self, session_id: str, signal_id: str) -> tuple[SourceSignal, MappingRecord]: ...
    def get_records(self, session_id: str, *,
                    status: list[str] | None = None) -> list[tuple[SourceSignal, MappingRecord]]:
        """Single filtered accessor replaces get_accepted/get_pending, which
        would otherwise multiply once more statuses exist."""
        ...
    def get_history(self, session_id: str, signal_id: str) -> list[MappingDecision]: ...

    def export_session(self, session_id: str) -> SessionSnapshot: ...
    def import_session(self, snapshot: SessionSnapshot) -> str:
        """Round-trips export_session. Raises on schema_version mismatch it
        cannot migrate."""
        ...
```

### Acceptance criteria

- Conformance suite passes for both in-memory and file-backed implementations.
- `import_session(export_session(s))` yields a snapshot equal to the original, decision log order included.
- Stale `expected_revision` raises `ConcurrentModificationError` and leaves state untouched.
- Re-running `add_signals` with a modified source (one signal renamed, one added, one removed) preserves decisions for surviving signals, reports the removed one, and leaves the new one `raw`.
- `JSONFileMappingStore` output is stable-ordered and pretty-printed — diffing two commits of a session file must be readable.

---

## Unit 6: ArtifactGenerator

### Reason-to-exist

The toolkit's value is the artefacts that plug into the existing COVESA/industry toolchain — VSS overlays, Kuksa feeder configs, a portable mapping document. All generation lives here.

### Architectural plan

- Pure transformation: accepted mappings → file **content as strings**. This unit performs **no file I/O**; Unit 8 owns writing. That keeps generators trivially testable and makes the ownership question explicit rather than implied.
- Multiple exporters behind one Protocol.
- Must emit overlays that `vss-tools` accepts. Overlay generation has two distinct cases and both are required:
  1. **Mapping onto an existing node** — emit only the node's path with a `dbc` extended attribute; do not restate `datatype`/`type`, which would conflict with the base catalog.
  2. **Defining a new node** (`exists_in_catalog=False`) — emit full `type`, `datatype`, `unit`, `description`, plus every intermediate branch, or `vss-tools` rejects the overlay.
- Every generated artefact carries the `Provenance` block as a header comment or field.
- **Target schema versions are pinned in this document** and asserted in tests, because these formats move: Kuksa `dbc2val` mapping is emitted in the `dbc2vss` YAML form used by kuksa-databroker 0.4.x. Any bump is a deliberate, tested change.

### Interfaces

```python
class GeneratedArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    filename: str                            # suggested name, no directory
    content: str
    media_type: str                          # "application/yaml", "application/json"
    warnings: list[str] = Field(default_factory=list)


class ArtifactGenerator(Protocol):
    def generate_vss_overlay(self, mappings: list[ResolvedMapping], overlay_name: str,
                             provenance: Provenance) -> GeneratedArtifact:
        """A .vspec overlay. Raises ArtifactGenerationError if a new node lacks
        the datatype/type/unit needed for a valid definition."""
        ...

    def generate_feeder_config(self, mappings: list[ResolvedMapping], provenance: Provenance,
                               target: Literal["kuksa", "vissr", "custom"] = "kuksa",
                               ) -> GeneratedArtifact:
        """Runtime mapping configuration. `target`, not `format` — the latter
        shadows a builtin."""
        ...

    def generate_mapping_json(self, mappings: list[ResolvedMapping],
                              provenance: Provenance) -> GeneratedArtifact:
        """Rich, versioned, round-trippable intermediate mapping document."""
        ...

    def generate_report(self, snapshot: SessionSnapshot,
                        issues: list[ValidationIssue]) -> GeneratedArtifact:
        """Markdown coverage/review summary: how many signals mapped, by which
        strategy, what is still pending, what validation flagged. This is the
        artefact a human actually reads before signing off."""
        ...


class ResolvedMapping(BaseModel):
    """A source signal joined to its accepted target — the only input shape a
    generator needs. Assembled by Unit 8 so generators never touch the store."""
    model_config = ConfigDict(extra="forbid", frozen=True)
    signal: SourceSignal
    accepted: AcceptedMapping
    node: Optional[VSSNode] = None           # None when defining a new node
```

### Acceptance criteria

- Golden-file tests for every generator; goldens reviewed by a human once, then diffed.
- Generated overlays are validated by actually invoking `vss-tools` in CI against the pinned VSS version — not by regex. A generator that emits plausible-looking invalid YAML is worthless.
- Generated Kuksa config is parsed by the pinned kuksa `dbc2vss` schema in CI.
- `generate_mapping_json` output round-trips back into `SessionSnapshot`-compatible mappings.
- Deterministic output: identical input → byte-identical string, keys sorted, no timestamps outside the provenance block.
- A 1:N mapping (one signal → three VSS paths) and an N:1 mapping (two signals → one path) each generate correctly in all three formats, or fail loudly with a clear message if the target format cannot express it.

---

## Unit 7: ValidationEngine

### Reason-to-exist

Suggestions and human decisions can still be wrong. Independent checks — unit consistency, range plausibility, log correlation, safety-critical flags — catch bad mappings before production.

### Architectural plan

- Validators are small, stateless, individually testable callables behind a registry, so a new check is a new function plus a registration, never an interface change.
- Operates on a single mapping or on a whole accepted set (the set-level checks — duplicate targets, contradictory units within a branch — are the ones that catch real integration bugs).
- Every issue carries a **stable machine-readable `code`**, so CI can allow-list known-acceptable warnings. Free-text-only issues cannot be triaged at scale.
- Log validation takes an injected `LogSource`, not a path. A protocol claiming to be stateless while opening files by name is untestable; the abstraction also lets blf/asc/mf4/candump readers be swapped.

### Interfaces

```python
class ValidationIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    severity: Literal["error", "warning", "info"]
    code: str                                # "UNIT_MISMATCH", "RANGE_EXCEEDS_VSS_MAX"
    message: str
    signal_id: Optional[str] = None
    related_path: Optional[str] = None
    validator: str                            # which check produced this
    details: dict[str, Any] = Field(default_factory=dict)


class LogSource(Protocol):
    """Decoded CAN traffic. Implementations: BlfLogSource, AscLogSource,
    CandumpLogSource, InMemoryLogSource (tests)."""
    def frames(self) -> Iterator[tuple[float, str, bytes]]: ...   # (t, message_id, payload)
    def duration_s(self) -> float: ...


class ValidationEngine(Protocol):
    def validate_mapping(self, mapping: ResolvedMapping) -> list[ValidationIssue]: ...

    def validate_set(self, mappings: list[ResolvedMapping]) -> list[ValidationIssue]:
        """Cross-mapping checks: duplicate VSS targets, unit inconsistency within
        a branch, instance collisions, incomplete instance coverage."""
        ...

    def validate_against_logs(self, mappings: list[ResolvedMapping], logs: LogSource,
                              ) -> list[ValidationIssue]:
        """Decode real traffic and check the mapping empirically: values inside
        the VSS min/max, observed cycle time near the declared one, signal not
        constant when it should vary, enum values all within the allowed set."""
        ...
```

**Baseline validators (each its own function, each its own test):**

| code | severity | check |
|---|---|---|
| `UNIT_MISSING_SOURCE` | warning | source signal has no unit but the VSS node requires one |
| `UNIT_MISMATCH` | error | source and target units are not convertible (via `UnitRegistry`) |
| `UNIT_UNCONVERTED` | error | units differ and no conversion is present in the transformation |
| `RANGE_EXCEEDS_VSS_MAX` | warning | source max, after transformation, exceeds VSS node max |
| `DATATYPE_NARROWING` | warning | source range does not fit the target datatype |
| `ENUM_INCOMPLETE` | warning | source enum values not covered by `value_map` and no default |
| `ENUM_NOT_ALLOWED` | error | mapped value is not in the VSS node's `allowed` list |
| `TARGET_IS_BRANCH` | error | accepted target is a branch, not a leaf |
| `TARGET_DEPRECATED` | warning | target node is deprecated in this VSS version |
| `TARGET_NOT_IN_CATALOG` | info | intentional new-node definition; must appear in the overlay |
| `DUPLICATE_TARGET` | error | two signals map to the same path without an explicit combiner |
| `ACTUATOR_FROM_READONLY` | warning | actuator target fed by a receive-only signal |
| `SAFETY_CRITICAL_LOW_CONFIDENCE` | error | brake/steering/airbag path accepted below the confidence floor |
| `CYCLE_TIME_MISMATCH` | warning | observed log cycle time deviates > 50 % from declared |
| `LOG_VALUE_OUT_OF_RANGE` | error | decoded log values fall outside the VSS range |
| `LOG_SIGNAL_CONSTANT` | info | signal never changed across the log |

### Acceptance criteria

- Every code in the table has a positive and a negative test.
- `validate_set` on a 500-mapping fixture completes in < 1 s.
- `validate_against_logs` runs against a synthetic `InMemoryLogSource`; no real vehicle log is required to test it.
- Adding a validator requires no change to `ValidationEngine` or its conformance suite — proven by adding a trivial one in a test.
- `SAFETY_CRITICAL_LOW_CONFIDENCE`'s path patterns and confidence floor are configuration, not hard-coded literals.

---

## Unit 8: MappingOrchestrator (workbench facade)

### Reason-to-exist

The single entry point composing all other units into a coherent workflow. The only unit that knows the whole pipeline. CLI, future HTTP API, and interactive UIs talk to nothing else.

### Architectural plan

- Thin. Business rules belong in the units; this layer sequences them, joins store data into `ResolvedMapping`, and owns filesystem writes.
- High-level commands: `ingest → suggest → review → validate → export`.
- Constructor takes an **`IngesterRegistry`**, not one ingester, so multi-format actually works end to end.
- Also owns: `Provenance` assembly, `auto_accept` policy (a bulk operation is what makes 3 000-signal DBCs tractable), and the resolve step that turns store records into generator input.
- No mutable default arguments — `list` and `dict` defaults in a signature are a live bug in Python.

### Interfaces

```python
class MappingOrchestrator:
    def __init__(self, *,
                 ingesters: IngesterRegistry,
                 kb: VSSKnowledgeBase,
                 suggester: SuggestionEngine,
                 store: MappingStore,
                 validator: ValidationEngine,
                 generator: ArtifactGenerator,
                 config: OrchestratorConfig | None = None) -> None: ...

    def ingest(self, source: str | Path, session_name: str) -> IngestSummary:
        """Resolve an ingester, parse, create a session, store signals.
        Returns counts and warnings — a bare session_id hides the warnings that
        a user most needs to see at this step."""
        ...

    def suggest_all(self, session_id: str, top_k: int = 5, *,
                    only_status: tuple[str, ...] = ("raw",)) -> SuggestSummary:
        """Batch-suggest and persist candidates. Re-runnable: by default it
        leaves already-reviewed records alone."""
        ...

    def accept(self, session_id: str, signal_id: str, target_path: str, *,
               transformation: TransformationSpec | None = None,
               reviewer: str | None = None,
               expected_revision: int | None = None,
               auto_transform: bool = True) -> MappingRecord:
        """auto_transform=True derives the transformation from source factor/
        offset plus the unit conversion from UnitRegistry — the common case
        should not require the caller to hand-build a TransformationSpec.
        Raises UnknownVSSPathError for a path absent from the catalog unless
        allow_new_nodes is set in config."""
        ...

    def accept_candidate(self, session_id: str, signal_id: str, candidate_index: int = 0,
                         *, reviewer: str | None = None) -> MappingRecord: ...
    def reject(self, session_id: str, signal_id: str, *, reviewer: str | None = None,
               notes: str | None = None) -> MappingRecord: ...

    def auto_accept(self, session_id: str, *, min_confidence: float = 0.9,
                    dry_run: bool = True) -> AutoAcceptReport:
        """Bulk-accept high-confidence candidates. dry_run defaults to True:
        the destructive direction should require an explicit opt-in."""
        ...

    def validate(self, session_id: str, *, logs: LogSource | None = None,
                 ) -> list[ValidationIssue]: ...

    def export(self, session_id: str, out_dir: Path,
               artifacts: tuple[Literal["overlay", "feeder", "json", "report"], ...] =
                   ("overlay", "json", "report"),
               *, fail_on: Literal["error", "warning", "never"] = "error",
               ) -> dict[str, Path]:
        """Validate, then generate, then write. Refuses to write when validation
        produces an issue at or above `fail_on`. Exporting a mapping set with
        known errors must be a conscious override, not the default."""
        ...

    def status(self, session_id: str) -> SessionStatus:
        """Counts by status, coverage %, per-strategy acceptance rate."""
        ...
```

### Acceptance criteria

- End-to-end test on a synthetic DBC: ingest → suggest → auto-accept → validate → export, asserting the overlay is `vss-tools`-valid.
- Every unit is stubbed by a fake in orchestrator tests; the orchestrator's own tests need no real embedding model, no network, and no LLM.
- `export` with a deliberately introduced `UNIT_MISMATCH` writes nothing and raises; with `fail_on="never"` it writes and returns the issues.
- `auto_accept(dry_run=True)` provably makes no store writes.
- Re-running the full pipeline over the same source and session is idempotent.

---

## Build order

The original order was sound; two changes matter.

| # | Unit | Note |
|---|---|---|
| 0 | **Gold set + metrics harness** | Small, and it must exist *before* Unit 4, or the intelligence core has no definition of done and "it seems to work" becomes the acceptance test. Needs only Unit 1's models. |
| 1 | **CoreSignalModel** | No dependencies. |
| 2 | **VSSKnowledgeBase** (incl. `UnitRegistry`) | Everything downstream needs the catalog and unit handling. |
| 3 | **SourceIngester** (DBC concrete + registry) | First point at which real data enters. |
| 4 | **SuggestionEngine** | Start with `RuleSuggester`, then `EmbeddingSuggester`, then hybrid. Gate on the step-0 metrics. |
| 5 | **MappingStore** | In-memory first; file-backed once the shape has stopped moving. |
| 6 | **ValidationEngine** | Moved ahead of generation: validation catches modelling mistakes in units 1–5 while they are still cheap to fix, and the generator wants a validated input contract to rely on. |
| 7 | **ArtifactGenerator** | Golden files plus real `vss-tools` validation in CI. |
| 8 | **MappingOrchestrator** | Wiring only. |
| 9 | **CLI** | Named explicitly as a consumer so it does not accrete logic. Talks only to Unit 8. |

Each unit can be fully implemented and tested against the interfaces of the units below it before the next layer starts. Units 3 and 5 are independent of each other and can proceed in parallel.

---

## Deliberate non-goals for v1

Stated so an agentic builder does not silently expand scope:

- No web UI. The CLI plus the JSON mapping document is the v1 interface surface.
- No ARXML/FIBEX ingester. The Protocol and registry make it additive; DBC is v1.
- No live databroker connection. Artefacts are written to disk; running them is the user's toolchain.
- No multi-user auth. `reviewer` is a free-text string, not an identity.
- No automatic VSS contribution/PR flow for new nodes.

## Open questions to settle before Unit 4

1. **Embedding model.** Local (`bge-m3`, `all-MiniLM`) versus hosted. Local keeps §0.8 egress at zero and CI offline; hosted may score better. Recommendation: local default, hosted opt-in.
2. **New-node policy.** When no VSS path fits, does the toolkit propose a new node under `Vehicle.…`, use a private branch prefix, or mark the signal unmappable? This changes `VSSTargetRef.exists_in_catalog` handling throughout. Recommendation: private branch prefix, configurable, defaulting to unmappable.
3. **Multi-version strategy.** Pin one VSS version per session (simple, recommended) or track a mapping across versions (much more work, and the migration story users will eventually ask for).
