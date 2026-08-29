// lib/background-audio.ts
// Audio session keepalive manager to enable uninterrupted background playback on mobile (iOS/Android) and desktop

class BackgroundAudioBridge {
  private audioCtx: AudioContext | null = null;
  private oscillatorNode: OscillatorNode | null = null;
  private gainNode: GainNode | null = null;
  private isInitialized = false;
  private isPlaying = false;

  public init() {
    if (this.isInitialized || typeof window === 'undefined') return;

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      this.audioCtx = new AudioContextClass();
      
      // Inaudible frequency oscillator to keep background media session active without making audible noise
      this.oscillatorNode = this.audioCtx.createOscillator();
      this.gainNode = this.audioCtx.createGain();

      // Set imperceptible gain
      this.gainNode.gain.setValueAtTime(0.00001, this.audioCtx.currentTime);
      this.oscillatorNode.frequency.setValueAtTime(440, this.audioCtx.currentTime);

      this.oscillatorNode.connect(this.gainNode);
      this.gainNode.connect(this.audioCtx.destination);
      
      this.oscillatorNode.start();
      this.isInitialized = true;
    } catch (e) {
      console.warn('Background audio bridge init info:', e);
    }
  }

  public start() {
    this.init();
    if (!this.audioCtx) return;

    try {
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      this.isPlaying = true;
    } catch {}
  }

  public stop() {
    if (!this.audioCtx) return;
    try {
      if (this.audioCtx.state === 'running') {
        this.audioCtx.suspend();
      }
      this.isPlaying = false;
    } catch {}
  }

  public isActive(): boolean {
    return this.isPlaying;
  }
}

export const backgroundAudioBridge = new BackgroundAudioBridge();
