/**
 * Configure Earth's rotation within the solar system visualization.
 *
 * The simulation in index.html builds a list of celestial bodies named `bodies`.
 * This helper finds the Earth entry and sets its self rotation so that one
 * orbital period results in roughly 365 rotations. The rotation axis is aligned
 * north–south with the short side of the `earth.jpeg` texture so the planet
 * spins correctly relative to its orbital plane.
 */
function setupEarth(bodies) {
  const earth = bodies.find(b => b.name === 'Earth');
  if (!earth) return;

  // Give Earth 365 rotations per orbit
  earth.selfRotationSpeed = earth.speed * 365;
  earth.selfRotationSpeed = earth.selfRotationSpeed/8; //too fast if realistic

  // Ensure texture orientation matches the north–south axis
  earth.obj.rotation.order = 'YXZ';
  earth.obj.rotation.y = 0;
}

// Execute immediately if bodies is already defined
if (typeof bodies !== 'undefined') {
  setupEarth(bodies);
}
