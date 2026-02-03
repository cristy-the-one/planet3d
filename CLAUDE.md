# CLAUDE.md - AI Assistant Guide for Planet3D

## Project Overview

**Planet3D** is an interactive 3D solar system visualization built with vanilla JavaScript and Three.js. It runs entirely in the browser with no build step required. The project is deployed to GitHub Pages.

**Live site**: Deployed automatically on push to `main` branch via GitHub Pages.

## Technology Stack

- **Three.js r128** - 3D rendering engine (loaded via CDN)
- **Tailwind CSS** - Utility-first CSS framework (loaded via CDN)
- **Web Audio API** - Comprehensive audio synthesis system
- **No build system** - Static site, all dependencies via CDN
- **No package.json** - Zero npm dependencies

## File Structure

```
planet3d/
├── index.html          # Main application (~3800 lines) - HTML, CSS, and JS combined
├── index.js            # Helper module for Earth rotation configuration
├── README.md           # User-facing documentation
├── AUDIO_FEATURES.md   # Detailed audio system documentation
├── .github/
│   └── workflows/
│       └── static.yml  # GitHub Pages deployment workflow
└── [textures]          # Planetary texture images
    ├── earth.jpeg, mars.jpg, jupiter.jpg, saturn.jpg, etc.
    ├── StarsTexture.jpeg, SaturnRingsTexture.png
    └── sky.jpg, space.jpg, moon.jpg
```

## Architecture

### Single-File Application

The entire application lives in `index.html` with embedded:
- CSS styles in `<style>` tags
- JavaScript in `<script>` tags at the bottom
- HTML structure for UI controls

### Key JavaScript Components

1. **CelestialAudioSystem class** (~line 1046)
   - Audio context management
   - Noise generators (white, pink, celestial ambient)
   - Spatial/binaural audio for celestial objects
   - Custom audio file playback

2. **UI Functions**
   - `setupCollapsiblePanels()` - Expandable control panels
   - `applyScale()` - UI scaling (S/M/L/XL)
   - `setMode()` - Kid/Nerd mode toggle
   - `applyVisualPreset()` - Visual themes (Default, WOW, Museum, Night Ride)

3. **Scene Components**
   - `createSatellite()` - Starlink constellation
   - `createUserAsteroid()` - User-placed asteroids
   - `createPlacementPlane()` - Asteroid placement surface
   - `animate()` - Main render loop

4. **Interaction Handlers**
   - `onCanvasClick()`, `onTouchStart()`, `onTouchEnd()` - Input handling
   - `__focusBody()` - Camera focus on celestial body
   - `__snapNearestBody()` - Kid mode planet assist

### Scene Elements

- **Celestial bodies**: Sun, 8 planets with accurate orbital mechanics
- **Moons**: Earth's Moon, Mars (Phobos, Deimos), Jupiter (Galilean moons)
- **Saturn's rings**: Custom textured ring system
- **Asteroid belt**: ~180 procedurally generated asteroids
- **Comets**: 2 dynamic comets with particle tails
- **Satellites**: Starlink constellation around Earth
- **Environment**: Skybox, nebula clouds, space dust particles
- **Post-processing**: Bloom effects, tone mapping

### Global State

Key state stored on `window` object:
- `window.__controlsRef` - OrbitControls reference
- `window.__cameraRef` - Camera reference
- `bodies` array - All celestial objects with orbital parameters

LocalStorage keys:
- `uiMode` - "kid" or "nerd"
- `uiScale` - UI size preference
- `audioPanelVisible` - Audio panel state

## Code Conventions

### Naming
- **camelCase** for functions and variables
- **PascalCase** for Three.js objects (Vector3, Mesh)
- **Double underscore prefix** (`__`) for private/internal functions
- **UPPER_CASE** for constants (e.g., `MAX_USER_ASTEROIDS`, `TAP_THRESHOLD`)

### Patterns
- IIFE wrappers for initialization code
- Custom events for UI communication (`ui:preset`, `ui:mode`)
- Try-catch for Web Audio API initialization
- RequestAnimationFrame for animation loop

### Style
- Embedded CSS with custom properties for theming
- Mobile-first responsive design with media queries
- Safe-area insets for notched devices
- Glass-morphism UI aesthetic

## Development Workflow

### Making Changes

1. **Edit `index.html`** directly - no compilation needed
2. **Test locally** by opening `index.html` in browser
3. **Commit and push** to feature branch
4. **Create PR** to merge into `main`
5. **Auto-deploy** happens on merge to `main`

### Branch Naming Convention

Recent commits show these patterns:
- `codex/` prefix - Visual/feature changes
- `copilot/` prefix - AI-assisted changes
- `claude/` prefix - Claude-assisted changes

### Deployment

GitHub Actions workflow (`.github/workflows/static.yml`):
- Triggers on push to `main`
- Uploads entire repository as static content
- Deploys to GitHub Pages

## Common Tasks

### Adding a New Planet/Moon

1. Add texture file to root directory
2. In `index.html`, find the `bodies` array initialization
3. Add new body object with orbital parameters:
   ```javascript
   {
     name: 'NewBody',
     radius: 0.5,
     distance: 10,
     speed: 0.01,
     obj: mesh,
     orbitTilt: 0,
     eccentricity: 0
   }
   ```
4. Create mesh using Three.js with texture

### Modifying Visual Presets

Find `applyVisualPreset()` function and add/modify preset configurations:
```javascript
case 'newpreset':
  bloomPass.strength = 1.5;
  bloomPass.radius = 0.5;
  // ... other visual settings
  break;
```

### Adding UI Controls

1. Add HTML element in the appropriate panel (`#controls` or `#audioControls`)
2. Add event listener in the JavaScript section
3. For persistent state, use localStorage

### Modifying Audio System

The `CelestialAudioSystem` class handles all audio:
- `createWhiteNoise()`, `createPinkNoise()`, `createCelestialAmbient()` - Background generators
- `updateSpatialAudio()` - Per-object spatial sounds
- Volume controlled via gain nodes

## Mobile Considerations

- Touch events handled separately from mouse
- Collapsible panels for space efficiency
- Safe-area insets for notched devices
- Visual viewport height (vvh) tracking for iOS URL bar
- Inline audio controls duplicated in main panel for mobile

## Browser Requirements

- WebGL support (Chrome, Firefox, Safari, Edge)
- Web Audio API
- ES6+ JavaScript
- File API for custom audio uploads

## Performance Notes

- Shadow map resolution: 2048x2048
- Spatial audio sources cleaned up after 2s inactivity
- Dust sprites wrap around camera to limit particle count
- Camera animations use quadratic easing

## Important Warnings

- **No build step** - Changes to index.html are live immediately
- **CDN dependencies** - Requires internet for Three.js and Tailwind
- **Audio requires user interaction** - Browser policy requires click to start
- **Large texture files** - Some textures are several MB

## Quick Reference

| Task | Location |
|------|----------|
| Main render loop | `animate()` function |
| Audio system | `CelestialAudioSystem` class |
| UI mode toggle | `setMode()` function |
| Visual presets | `applyVisualPreset()` function |
| Planet data | `bodies` array |
| Camera controls | OrbitControls setup section |
| Post-processing | EffectComposer setup section |
