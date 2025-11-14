# Planet3D - Spectacular Solar System with Immersive Audio

An interactive 3D solar system simulation with realistic orbital mechanics and an immersive celestial audio system.

## Features

### Visual Features
- Realistic solar system with Sun and 8 planets
- Planetary moons and ring systems
- Asteroid belt and comets
- Starlink satellite constellation around Earth
- Interactive asteroid placement in freeze mode
- Multiple viewing angles and camera controls
- Bloom effects and atmospheric glows
- Particle trails for planets and asteroids

### Audio Features 🎵 **NEW!**

The simulation now includes a comprehensive audio system for maximum immersion:

#### Background Ambient Sounds
Choose from three relaxing background options:
- **White Noise** - Classic relaxation sound
- **Pink Noise** - Soft, ocean-like ambience (default)
- **Celestial** - Custom synthesized space atmosphere with layered harmonics

#### Custom Audio Loops
- Upload your own audio files (mp3, wav, ogg)
- Seamlessly loop your favorite space music or ambient tracks
- Blend with background sounds

#### Spatial Audio
Experience 3D positional audio as you navigate:
- Objects within 30 units trigger subtle spatial sounds
- Binaural stereo panning (left/right positioning)
- Distance-based volume (closer = louder)
- Subtle frequency variation (Doppler-like effect)
- Works for planets, moons, comets, and asteroids

#### Audio Controls
Complete control panel in bottom-right corner:
- Master volume control
- Individual volume sliders for each audio type
- Background type selector
- File upload for custom loops
- Enable/disable spatial audio
- Start/Stop button

**Note**: Click "Start Audio" to enable sound (required by browser policies)

For detailed audio documentation, see [AUDIO_FEATURES.md](AUDIO_FEATURES.md)

## Usage

1. Open `index.html` in a modern web browser
2. Click "Start Audio" to enable the celestial soundscape
3. Use mouse to rotate view, scroll to zoom
4. Select different viewing angles from the "View from" dropdown
5. Adjust simulation speed with the speed slider
6. Click "Freeze" to place asteroids and watch them interact
7. Customize audio with the controls panel

## Controls

**Mouse**:
- Left click + drag: Rotate view
- Right click + drag: Pan view
- Scroll: Zoom in/out
- Click (in freeze mode): Place asteroids

**Buttons**:
- Pause/Play: Control animation
- Freeze: Enter asteroid placement mode
- Reset View: Return to default camera position
- Satellites: Toggle satellite visibility
- Start Audio: Enable/disable audio system

## Audio Tips for Maximum Immersion

1. Use **Celestial** ambient for the most space-like atmosphere
2. Upload a space ambient soundtrack as custom loop (keep volume moderate)
3. Keep spatial audio enabled but subtle (30-40% volume)
4. Use **headphones** for the best binaural/spatial effect
5. Navigate close to planets to experience proximity audio
6. Adjust master volume to comfortable listening level

## Technical Details

- Built with Three.js for 3D rendering
- Web Audio API for immersive sound
- Realistic elliptical orbits with Kepler's laws
- N-body physics simulation for asteroids
- Bloom post-processing effects
- Pink noise generation using Paul Kellet's algorithm
- 5-oscillator celestial drone synthesis
- Spatial audio with per-object tracking

## Browser Compatibility

- Modern browsers with WebGL support (Chrome, Firefox, Safari, Edge)
- Web Audio API required for audio features
- File API for custom audio upload
- Best experienced on desktop/laptop with headphones

## License

MIT License - See project repository for details

---

**Enjoy your journey through the solar system! 🌌✨🎵**
