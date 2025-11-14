# Audio Features Documentation

## Overview
The Planet3D solar system simulation now includes a comprehensive immersive audio system that creates a celestial soundscape to enhance the viewing experience.

## Features

### 1. Background Ambient Sounds
Three types of relaxing background noise are available:

- **White Noise**: Classic white noise for relaxation and focus
- **Pink Noise** (Default): Softer, more pleasant noise similar to ocean waves or rainfall
- **Celestial**: Custom-synthesized ambient drone using layered sine waves with slow modulation, creating an ethereal space atmosphere

### 2. Custom Audio Loops
Upload your own audio files to play as background loops:
- Supports standard audio formats (mp3, wav, ogg, etc.)
- Seamlessly loops the audio
- Blends with ambient sounds
- Independent volume control

### 3. Spatial/Binaural Audio
Immersive 3D audio for celestial objects:
- Objects passing close to the camera trigger subtle spatial sounds
- **Distance-based volume**: Objects within 30 units can be heard, with volume following inverse-square law
- **Binaural panning**: Stereo positioning based on screen position (-1 left, +1 right)
- **Frequency variation**: Subtle Doppler-like effect as objects move
- **Discrete sounds**: Very subtle, non-intrusive hums and whooshes
- Works for: Planets, moons, comets, and user-placed asteroids

### 4. Audio Controls Panel
Located in the bottom-right corner of the screen:

#### Master Controls
- **Start/Stop Audio**: Single button to enable/disable all audio
- **Master Volume**: Controls overall audio output (0-100%)

#### Background Controls
- **Type Selector**: Choose between Off, White Noise, Pink Noise, or Celestial
- **Volume**: Control ambient sound volume (0-100%)

#### Custom Loop Controls
- **File Upload**: Browse and select local audio files
- **Volume**: Control custom audio volume (0-100%)

#### Spatial Audio Controls
- **Enable Toggle**: Checkbox to enable/disable spatial audio for objects
- **Volume**: Control spatial audio volume (0-100%)

## Technical Implementation

### CelestialAudioSystem Class
The core audio engine built on the Web Audio API:

```javascript
class CelestialAudioSystem {
  // Audio context and gain nodes for mixing
  // Noise generators (white, pink, celestial)
  // Custom audio buffer management
  // Spatial audio sources tracking
  // Volume controls with smooth ramping
}
```

### Audio Synthesis Details

#### White Noise
- Random samples [-1, 1] at audio sample rate
- Low-pass filtered at 3000 Hz for smoothness

#### Pink Noise
- Generated using Paul Kellet's algorithm
- Provides 1/f frequency spectrum (more bass than white noise)
- Low-pass filtered at 2000 Hz

#### Celestial Ambient
- Five sine wave oscillators at frequencies: 55, 82.5, 110, 165, 220 Hz (perfect fifths: A1-E2-A2-E3-A3)
- Each with decreasing amplitude (creates harmonic richness)
- Slow LFO (Low-Frequency Oscillator) modulation for movement
- Stereo panning for width
- Low-pass filter with its own LFO (sweeps 500-1100 Hz)

#### Spatial Audio
- Dedicated oscillator per tracked object
- Frequency: 80-120 Hz (low, subtle hum)
- Volume calculated from camera distance
- Stereo panner for left/right positioning
- Automatic cleanup of inactive sources

### Browser Compatibility
- Uses Web Audio API (supported in modern browsers)
- Requires user interaction to start (browser policy)
- Graceful degradation if audio context fails

## Usage Instructions

1. **Starting Audio**:
   - Click "Start Audio" button
   - Audio context initializes (required by browsers)
   - Default: Pink noise at 30% volume starts playing

2. **Changing Background**:
   - Use the Background dropdown to select type
   - Adjust volume with the slider below

3. **Adding Custom Sounds**:
   - Click "Choose File" under Custom Loop
   - Select an audio file from your computer
   - Adjust volume as desired
   - Audio will loop automatically

4. **Experiencing Spatial Audio**:
   - Ensure "Enable for objects" is checked
   - Navigate close to planets, moons, comets, or asteroids
   - Listen for subtle spatial sounds in stereo
   - Objects within ~30 units trigger audio
   - Closer objects are louder
   - Position (left/right) affects stereo panning

5. **Adjusting Volumes**:
   - Master: Overall output level
   - Background: Ambient noise level
   - Custom: Uploaded audio level
   - Spatial: Object proximity sounds level

## Performance Considerations

- Spatial audio sources are automatically cleaned up after 2 seconds of inactivity
- Audio processing runs in separate thread (Web Audio API)
- Minimal impact on rendering performance
- Recommended to keep spatial volume moderate to avoid overwhelming the soundscape

## Tips for Maximum Immersion

1. Use **Celestial** ambient for the most space-like atmosphere
2. Upload a **space ambient soundtrack** as custom loop (low volume)
3. Keep spatial audio **enabled but subtle** (30-40% volume)
4. Adjust master volume to comfortable listening level
5. Use headphones for best binaural/spatial effect
6. Navigate close to planets to experience proximity audio
7. Place asteroids in freeze mode and watch them interact with spatial audio as they orbit

## Future Enhancements (Potential)

- Pre-loaded celestial sound effects library
- Per-object sound customization
- Distance-based filter cutoff (far objects sound muffled)
- Reverb for space ambience
- Planet-specific audio signatures
- Collision sound effects
- Volume automation based on simulation events

---

**Note**: Audio features require modern browser with Web Audio API support (Chrome, Firefox, Safari, Edge). Due to browser security policies, audio must be started via user interaction (clicking "Start Audio" button).
