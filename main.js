// main.js (ES module) — Neon Studio Ultimate
const STEPS = 32;
const DEFAULT_BPM = 120;

// ---------- Audio Engine ----------
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.tracks = [];
    this.buses = {};
    this.analyser = null;
    this.oscAnalyser = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.95;

    // Master chain: master -> compressor -> destination
    this.masterCompressor = this.ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.value = -3;
    this.masterCompressor.ratio.value = 6;
    this.master.connect(this.masterCompressor);
    this.masterCompressor.connect(this.ctx.destination);

    // Reverb send (convolver optional)
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.25;
    this.reverbConvolver = this.ctx.createConvolver();
    // fallback simple delay reverb if no IR loaded
    this.reverbFallbackDelay = this.ctx.createDelay(3.0);
    this.reverbFallbackDelay.delayTime.value = 0.28;
    this.reverbFB = this.ctx.createGain();
    this.reverbFB.gain.value = 0.45;
    this.reverbSend.connect(this.reverbFallbackDelay);
    this.reverbFallbackDelay.connect(this.reverbFB);
    this.reverbFB.connect(this.reverbFallbackDelay);
    this.reverbFallbackDelay.connect(this.master);

    // Delay bus
    this.delayBus = this.ctx.createDelay(2.0);
    this.delayBus.delayTime.value = 0.35;
    const delayFB = this.ctx.createGain();
    delayFB.gain.value = 0.25;
    this.delayBus.connect(delayFB);
    delayFB.connect(this.delayBus);
    this.delayBus.connect(this.master);

    // analysers
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.oscAnalyser = this.ctx.createAnalyser();
    this.oscAnalyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.master.connect(this.oscAnalyser);

    // create default buses
    this.createBus('masterBus', this.master);
  }

  createBus(name, node) {
    this.buses[name] = node;
  }

  createTrack(name, instrument) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0.9;
    const pan = this.ctx.createStereoPanner();
    const sendReverb = this.ctx.createGain();
    sendReverb.gain.value = 0.2;
    const sendDelay = this.ctx.createGain();
    sendDelay.gain.value = 0.15;

    // instrument output -> track gain -> pan -> master
    instrument.output.connect(gain);
    gain.connect(pan);
    pan.connect(this.master);

    // sends
    gain.connect(sendReverb);
    sendReverb.connect(this.reverbSend);
    gain.connect(sendDelay);
    sendDelay.connect(this.delayBus);

    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 256;
    pan.connect(analyser);

    const track = {
      id: `track-${this.tracks.length}`,
      name,
      instrument,
      gain,
      pan,
      sendReverb,
      sendDelay,
      analyser,
      pattern: new Array(STEPS).fill(null),
      plugins: [],
    };

    this.tracks.push(track);
    return track;
  }

  async loadImpulse(url) {
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    const ir = await this.ctx.decodeAudioData(ab);
    this.reverbConvolver.buffer = ir;
    // route reverb send to convolver then to master
    this.reverbSend.disconnect();
    this.reverbSend.connect(this.reverbConvolver);
    this.reverbConvolver.connect(this.master);
  }

  startRecording() {
    if (!this.ctx) return;
    const dest = this.ctx.createMediaStreamDestination();
    this.master.connect(dest);
    this.mediaRecorder = new MediaRecorder(dest.stream);
    this.recordedChunks = [];
    this.mediaRecorder.ondataavailable = (e) => this.recordedChunks.push(e.data);
    this.mediaRecorder.start();
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) return resolve(null);
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }
}

// ---------- Instrument base ----------
class Instrument {
  constructor(engine) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.output = this.ctx.createGain();
    this.output.gain.value = 1.0;
  }
  noteOn(note, velocity = 1, time = 0) {}
  noteOff(note, time = 0) {}
}

// ---------- Sampler (generic) ----------
class Sampler extends Instrument {
  constructor(engine, sampleMap = {}) {
    super(engine);
    this.sampleMap = sampleMap;
    this.buffers = {};
  }

  async loadAll() {
    const keys = Object.keys(this.sampleMap);
    await Promise.all(keys.map(k => this.loadSample(k, this.sampleMap[k])));
  }

  async loadSample(key, url) {
    try {
      const resp = await fetch(url);
      const ab = await resp.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(ab);
      this.buffers[key] = buf;
    } catch (e) {
      console.warn('Sample load failed', key, url, e);
    }
  }

  noteOn(key, velocity = 1, time = 0) {
    const buf = this.buffers[key];
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = velocity;
    src.connect(g);
    g.connect(this.output);
    src.start(this.ctx.currentTime + time);
    src.stop(this.ctx.currentTime + time + buf.duration + 0.05);
  }
}

// ---------- Realistic Piano (multi-velocity layered sampler) ----------
class RealisticPiano extends Sampler {
  constructor(engine, layeredMap = {}) {
    super(engine, layeredMap);
    // layeredMap: { 'C4': {low:url, mid:url, high:url}, ... }
  }

  async loadAll() {
    const keys = Object.keys(this.sampleMap);
    for (const k of keys) {
      const entry = this.sampleMap[k];
      if (typeof entry === 'string') {
        await this.loadSample(k, entry);
      } else if (typeof entry === 'object') {
        this.buffers[k] = {};
        for (const layer of Object.keys(entry)) {
          try {
            const resp = await fetch(entry[layer]);
            const ab = await resp.arrayBuffer();
            const buf = await this.ctx.decodeAudioData(ab);
            this.buffers[k][layer] = buf;
          } catch (e) {
            console.warn('Piano layer load failed', k, layer, e);
          }
        }
      }
    }
  }

  noteOn(nameOrMidi, velocity = 1, time = 0) {
    // accept midi number or sample name
    const key = typeof nameOrMidi === 'number' ? midiToName(nameOrMidi) : nameOrMidi;
    const entry = this.buffers[key];
    if (!entry) return;
    let buf;
    if (entry instanceof AudioBuffer) buf = entry;
    else {
      if (velocity < 0.33) buf = entry.low || entry.mid || entry.high;
      else if (velocity < 0.66) buf = entry.mid || entry.high || entry.low;
      else buf = entry.high || entry.mid || entry.low;
    }
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = velocity;
    const body = this.ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 12000;
    src.connect(g);
    g.connect(body);
    body.connect(this.output);
    src.start(this.ctx.currentTime + time);
    src.stop(this.ctx.currentTime + time + buf.duration + 0.05);
  }
}

// ---------- Analog poly synth ----------
class AnalogPoly extends Instrument {
  constructor(engine, voices = 8) {
    super(engine);
    this.voices = [];
    this.pool = Array.from({length:voices}, ()=>({busy:false}));
    this.filterCutoff = 2000;
    this.filterQ = 1.2;
  }

  _alloc() {
    const v = this.pool.find(p=>!p.busy);
    if (!v) return null;
    v.busy = true;
    v.osc = this.ctx.createOscillator();
    v.osc.type = 'sawtooth';
    v.gain = this.ctx.createGain();
    v.gain.gain.value = 0;
    v.filter = this.ctx.createBiquadFilter();
    v.filter.type = 'lowpass';
    v.filter.frequency.value = this.filterCutoff;
    v.filter.Q.value = this.filterQ;
    v.osc.connect(v.filter);
    v.filter.connect(v.gain);
    v.gain.connect(this.output);
    v.osc.start();
    return v;
  }

  _free(v) {
    try { v.osc.stop(); } catch(e){}
    v.busy = false;
  }

  noteOn(midi, vel=1, time=0) {
    const freq = 440 * Math.pow(2, (midi - 69)/12);
    const v = this._alloc();
    if (!v) return null;
    v.osc.frequency.setValueAtTime(freq, this.ctx.currentTime + time);
    v.gain.gain.setValueAtTime(0, this.ctx.currentTime + time);
    v.gain.gain.linearRampToValueAtTime(0.8 * vel, this.ctx.currentTime + time + 0.01);
    this.voices.push(v);
    return v;
  }

  noteOff(midi, time=0) {
    const v = this.voices.pop();
    if (!v) return;
    v.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    v.gain.gain.setValueAtTime(v.gain.gain.value, this.ctx.currentTime + time);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + time + 0.5);
    setTimeout(()=>this._free(v), 700);
  }
}

// ---------- FM synth ----------
class FMSynth extends Instrument {
  constructor(engine) {
    super(engine);
    this.modIndex = 80;
  }

  noteOn(midi, vel=1, time=0) {
    const carrier = this.ctx.createOscillator();
    const mod = this.ctx.createOscillator();
    const modGain = this.ctx.createGain();
    const outGain = this.ctx.createGain();
    outGain.gain.value = 0;
    const freq = 440 * Math.pow(2, (midi - 69)/12);
    carrier.type = 'sine';
    mod.type = 'sine';
    carrier.frequency.value = freq;
    mod.frequency.value = freq * 2;
    modGain.gain.value = this.modIndex;
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    carrier.connect(outGain);
    outGain.connect(this.output);
    carrier.start();
    mod.start();
    outGain.gain.linearRampToValueAtTime(0.7*vel, this.ctx.currentTime + 0.01);
    return {carrier, mod, outGain};
  }

  noteOff(nodes, time=0) {
    if (!nodes) return;
    nodes.outGain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.4);
    setTimeout(()=>{ try{ nodes.carrier.stop(); nodes.mod.stop(); }catch(e){} }, 600);
  }
}

// ---------- Granular (simple) ----------
class Granular extends Instrument {
  constructor(engine, bufferUrl=null) {
    super(engine);
    this.buffer = null;
    if (bufferUrl) this.load(bufferUrl);
  }
  async load(url) {
    const resp = await fetch(url);
    const ab = await resp.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(ab);
  }
  grain(time=0, pos=0, dur=0.2, pitch=1, gain=0.6) {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = pitch;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(this.output);
    src.start(this.ctx.currentTime + time, pos, dur);
    src.stop(this.ctx.currentTime + time + dur + 0.05);
  }
}

// ---------- Effects helpers ----------
function createEQ(ctx) {
  const low = ctx.createBiquadFilter(); low.type='lowshelf'; low.frequency.value=200;
  const mid = ctx.createBiquadFilter(); mid.type='peaking'; mid.frequency.value=1000; mid.Q.value=1;
  const high = ctx.createBiquadFilter(); high.type='highshelf'; high.frequency.value=4000;
  low.connect(mid); mid.connect(high);
  return {node: low, low, mid, high};
}

function createChorus(ctx) {
  const input = ctx.createGain();
  const delay = ctx.createDelay();
  delay.delayTime.value = 0.03;
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.8;
  lfoGain.gain.value = 0.01;
  lfo.connect(lfoGain);
  lfoGain.connect(delay.delayTime);
  lfo.start();
  input.connect(delay);
  const out = ctx.createGain();
  delay.connect(out);
  input.connect(out);
  return {input, out, lfo, lfoGain};
}

// ---------- Sequencer ----------
class Sequencer {
  constructor(engine, bpm = DEFAULT_BPM) {
    this.engine = engine;
    this.bpm = bpm;
    this.isPlaying = false;
    this.currentStep = 0;
    this.timer = null;
    this.stepCallback = null;
    this.swing = 0;
  }

  start() {
    if (!this.engine.ctx) return;
    this.isPlaying = true;
    this.currentStep = 0;
    this._tick();
  }

  stop() {
    this.isPlaying = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _tick() {
    const secondsPerBeat = 60 / this.bpm;
    const stepDuration = secondsPerBeat / 8;
    const now = this.engine.ctx.currentTime;
    const swingOffset = (this.currentStep % 2 === 1) ? this.swing * stepDuration : 0;
    if (this.stepCallback) this.stepCallback(this.currentStep, now + 0.02 + swingOffset);
    this.currentStep = (this.currentStep + 1) % STEPS;
    this.timer = setTimeout(()=>this._tick(), (stepDuration + swingOffset) * 1000);
  }

  setBPM(b) { this.bpm = b; }
  setSwing(s) { this.swing = s; }
}

// ---------- UI & App wiring ----------
class UI {
  constructor() {
    this.engine = new AudioEngine();
    this.sequencer = new Sequencer(this.engine, DEFAULT_BPM);
    this.tracksContainer = document.getElementById('tracks');
    this.tracksList = document.getElementById('tracksList');
    this.spectrum = document.getElementById('spectrum');
    this.osc = document.getElementById('osc');
    this.spectrumCtx = this.spectrum.getContext('2d');
    this.oscCtx = this.osc.getContext('2d');
    this.playBtn = document.getElementById('playBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.bpmInput = document.getElementById('bpmInput');
    this.swingInput = document.getElementById('swing');
    this.recordBtn = document.getElementById('recordBtn');
    this.pluginContainer = document.getElementById('pluginContainer');
    this.patternKey = 'neon-studio-ultimate-project';
  }

  async init() {
    await this.engine.init();
    this.bindTransport();
    this.createStarterTracks();
    this.buildUITracks();
    this.sequencer.stepCallback = (s,t)=>this.onStep(s,t);
    this.startVisualizers();
    this.bindPalette();
    this.bindProjectButtons();
    this.bindRecording();
    this.bindMIDI();
  }

  bindTransport() {
    this.playBtn.addEventListener('click', ()=> {
      this.sequencer.start();
      this.playBtn.classList.add('active');
    });
    this.stopBtn.addEventListener('click', ()=> {
      this.sequencer.stop();
      this.playBtn.classList.remove('active');
      this.clearPlayingHighlights();
    });
    this.bpmInput.addEventListener('change', (e)=> {
      const v = parseFloat(e.target.value) || DEFAULT_BPM;
      this.sequencer.setBPM(v);
    });
    this.swingInput.addEventListener('input', (e)=> {
      this.sequencer.setSwing(parseFloat(e.target.value));
    });
  }

  createStarterTracks() {
    // piano sample map placeholders; replace with high-quality multi-velocity samples
    const pianoMap = {
      'C4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/C4.mp3' },
      'D4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/D4.mp3' },
      'E4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/E4.mp3' },
      'F4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/F4.mp3' },
      'G4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/G4.mp3' },
      'A4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/A4.mp3' },
      'B4': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/B4.mp3' },
      'C5': { low: 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/piano-mp3/C5.mp3' }
    };

    const piano = new RealisticPiano(this.engine, pianoMap);
    piano.loadAll().then(()=>console.log('Piano loaded'));
    const pianoTrack = this.engine.createTrack('Grand Piano', piano);

    const epiano = new Sampler(this.engine, {
      'C4': 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/electric_piano-mp3/C4.mp3',
      'E4': 'https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM/electric_piano-mp3/E4.mp3'
    });
    epiano.loadAll();
    this.engine.createTrack('Electric Piano', epiano);

    const analog = new AnalogPoly(this.engine, 8);
    this.engine.createTrack('Analog Poly', analog);

    const fm = new FMSynth(this.engine);
    this.engine.createTrack('FM Lead', fm);

    const bass = new AnalogPoly(this.engine, 4);
    this.engine.createTrack('Bass Synth', bass);

    const drum = new Sampler(this.engine, {
      'kick': 'https://cdn.jsdelivr.net/gh/terkelg/awesome-creative-coding@master/assets/samples/kick.wav',
      'snare': 'https://cdn.jsdelivr.net/gh/terkelg/awesome-creative-coding@master/assets/samples/snare.wav',
      'hihat': 'https://cdn.jsdelivr.net/gh/terkelg/awesome-creative-coding@master/assets/samples/hihat.wav'
    });
    drum.loadAll();
    this.engine.createTrack('Drum Sampler', drum);

    const pad = new Sampler(this.engine, {});
    this.engine.createTrack('Orchestral Pad', pad);
  }

  buildUITracks() {
    this.tracksContainer.innerHTML = '';
    this.tracksList.innerHTML = '';
    this.engine.tracks.forEach((t, idx) => {
      // left list
      const li = document.createElement('div');
      li.className = 'track-item';
      li.id = t.id;
      const color = document.createElement('div');
      color.className = 'track-color';
      color.style.background = randomAccent();
      const meta = document.createElement('div');
      meta.innerHTML = `<div style="font-weight:600">${t.name}</div><div class="track-meta">track ${idx+1}</div>`;
      li.appendChild(color);
      li.appendChild(meta);
      this.tracksList.appendChild(li);

      // arranger row
      const row = document.createElement('div');
      row.className = 'track-row';
      const label = document.createElement('div');
      label.style.width = '160px';
      label.innerHTML = `<strong>${t.name}</strong><div style="font-size:12px;color:${getMuted()}">track ${idx+1}</div>`;
      const lane = document.createElement('div');
      lane.className = 'track-lane';
      lane.dataset.track = t.id;
      for (let i=0;i<STEPS;i++){
        const step = document.createElement('div');
        step.className = 'step';
        step.dataset.step = i;
        step.addEventListener('click', ()=> this.onStepClick(t, i, step));
        lane.appendChild(step);
      }
      row.appendChild(label);
      row.appendChild(lane);
      this.tracksContainer.appendChild(row);
    });
  }

  onStepClick(track, stepIndex, stepEl) {
    if (!track.pattern[stepIndex]) track.pattern[stepIndex] = [];
    // toggle a simple event: for drums add 'kick', for melodic add C4 midi
    if (track.name.toLowerCase().includes('drum')) {
      const idx = track.pattern[stepIndex].indexOf('kick');
      if (idx >= 0) {
        track.pattern[stepIndex].splice(idx,1);
        stepEl.classList.remove('active');
      } else {
        track.pattern[stepIndex].push('kick');
        stepEl.classList.add('active');
      }
    } else {
      const note = { note: 60, vel: 0.9, dur: 0.5 };
      const exists = track.pattern[stepIndex].some(n => n.note === note.note);
      if (exists) {
        track.pattern[stepIndex] = track.pattern[stepIndex].filter(n => n.note !== note.note);
        stepEl.classList.remove('active');
      } else {
        track.pattern[stepIndex].push(note);
        stepEl.classList.add('active');
      }
    }
  }

  onStep(stepIndex, time) {
    this.highlightStep(stepIndex);
    this.engine.tracks.forEach(track => {
      const cell = track.pattern[stepIndex];
      if (!cell) return;
      for (const ev of cell) {
        if (typeof ev === 'string') {
          // drum sample name
          track.instrument.noteOn(ev, 1, 0);
        } else if (ev.note) {
          // melodic event
          if (track.instrument instanceof RealisticPiano) {
            const name = midiToName(ev.note);
            track.instrument.noteOn(name, ev.vel, 0);
          } else if (track.instrument instanceof AnalogPoly) {
            track.instrument.noteOn(ev.note, ev.vel, 0);
            setTimeout(()=>track.instrument.noteOff(ev.note,0), ev.dur*1000);
          } else if (track.instrument instanceof FMSynth) {
            const nodes = track.instrument.noteOn(ev.note, ev.vel, 0);
            setTimeout(()=>track.instrument.noteOff(nodes,0), ev.dur*1000);
          } else {
            track.instrument.noteOn(ev.note, ev.vel, 0);
          }
        }
      }
    });
  }

  highlightStep(stepIndex) {
    document.querySelectorAll('.step').forEach(s=>s.classList.remove('playing'));
    document.querySelectorAll(`.step[data-step="${stepIndex}"]`).forEach(s=>s.classList.add('playing'));
  }

  clearPlayingHighlights() {
    document.querySelectorAll('.step').forEach(s=>s.classList.remove('playing'));
  }

  startVisualizers() {
    const analyser = this.engine.analyser;
    const oscAnalyser = this.engine.oscAnalyser;
    const specCtx = this.spectrumCtx;
    const oscCtx = this.oscCtx;
    const canvasW = this.spectrum.width;
    const canvasH = this.spectrum.height;

    const draw = () => {
      requestAnimationFrame(draw);
      if (!analyser) return;
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      specCtx.fillStyle = '#020617';
      specCtx.fillRect(0,0,canvasW,canvasH);
      const barWidth = canvasW / data.length * 2.2;
      let x=0;
      for (let i=0;i<data.length;i++){
        const v = data[i]/255;
        const h = v*canvasH;
        const grad = specCtx.createLinearGradient(0,0,0,canvasH);
        grad.addColorStop(0,'#06b6d4');grad.addColorStop(0.5,'#7c3aed');grad.addColorStop(1,'#ff6b6b');
        specCtx.fillStyle = grad;
        specCtx.fillRect(x,canvasH-h,barWidth,h);
        x+=barWidth+1;
      }

      const buf = new Uint8Array(oscAnalyser.fftSize);
      oscAnalyser.getByteTimeDomainData(buf);
      oscCtx.fillStyle = '#020617';
      oscCtx.fillRect(0,0,canvasW,canvasH);
      oscCtx.lineWidth = 2;
      oscCtx.strokeStyle = '#38bdf8';
      oscCtx.beginPath();
      const slice = canvasW / buf.length;
      let px = 0;
      for (let i=0;i<buf.length;i++){
        const v = buf[i]/128.0;
        const y = v * canvasH/2;
        if (i===0) oscCtx.moveTo(px,y); else oscCtx.lineTo(px,y);
        px += slice;
      }
      oscCtx.stroke();
    };
    draw();
  }

  bindPalette() {
    document.querySelectorAll('.inst-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> {
        const id = btn.dataset.inst;
        if (id==='piano') {
          const piano = new RealisticPiano(this.engine, {});
          piano.loadAll();
          const t = this.engine.createTrack('Grand Piano (new)', piano);
          this.buildUITracks();
        } else if (id==='analog') {
          const a = new AnalogPoly(this.engine, 8);
          this.engine.createTrack('Analog Poly (new)', a);
          this.buildUITracks();
        } else if (id==='fm') {
          const f = new FMSynth(this.engine);
          this.engine.createTrack('FM Lead (new)', f);
          this.buildUITracks();
        } else if (id==='drum') {
          const d = new Sampler(this.engine, {});
          this.engine.createTrack('Drum Sampler (new)', d);
          this.buildUITracks();
        } else if (id==='granular') {
          const g = new Granular(this.engine, null);
          this.engine.createTrack('Granular (new)', g);
          this.buildUITracks();
        } else {
          const s = new Sampler(this.engine, {});
          this.engine.createTrack('Sampler (new)', s);
          this.buildUITracks();
        }
      });
    });
  }

  bindProjectButtons() {
    document.getElementById('saveProject').addEventListener('click', ()=> {
      const data = {
        bpm: this.sequencer.bpm,
        tracks: this.engine.tracks.map(t => ({ name: t.name, pattern: t.pattern }))
      };
      localStorage.setItem(this.patternKey, JSON.stringify(data));
      alert('Project saved locally');
    });

    document.getElementById('loadProject').addEventListener('click', ()=> {
      const raw = localStorage.getItem(this.patternKey);
      if (!raw) { alert('No saved project'); return; }
      const data = JSON.parse(raw);
      if (data.bpm) { this.sequencer.setBPM(data.bpm); this.bpmInput.value = data.bpm; }
      for (let i=0;i<data.tracks.length && i<this.engine.tracks.length;i++){
        this.engine.tracks[i].pattern = data.tracks[i].pattern;
      }
      this.buildUITracks();
      alert('Project loaded');
    });
  }

  bindRecording() {
    this.recordBtn.addEventListener('click', async ()=> {
      if (this.recordBtn.classList.contains('recording')) {
        this.recordBtn.classList.remove('recording');
        const blob = await this.engine.stopRecording();
        if (blob) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'neon-studio-recording.webm';
          a.click();
          URL.revokeObjectURL(url);
        }
      } else {
        await this.engine.init();
        this.engine.startRecording();
        this.recordBtn.classList.add('recording');
      }
    });
  }

  bindMIDI() {
    if (!navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then(midi => {
      midi.inputs.forEach(input => {
        input.onmidimessage = (msg) => {
          const [status, data1, data2] = msg.data;
          const cmd = status >> 4;
          if (cmd === 9) {
            const note = data1;
            const vel = data2 / 127;
            const track = this.engine.tracks[0];
            if (track) {
              if (track.instrument instanceof RealisticPiano) {
                const name = midiToName(note);
                track.instrument.noteOn(name, vel, 0);
              } else {
                track.instrument.noteOn(note, vel, 0);
              }
            }
          }
        };
      });
    }).catch(()=>console.warn('MIDI not available'));
  }
}

// ---------- Utilities ----------
function midiToName(m) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const octave = Math.floor(m/12)-1;
  return names[m%12] + octave;
}

function randomAccent() {
  const arr = ['linear-gradient(180deg,#ff6b6b,#f97316)','linear-gradient(180deg,#7c3aed,#06b6d4)','linear-gradient(180deg,#34d399,#10b981)'];
  return arr[Math.floor(Math.random()*arr.length)];
}

function getMuted(){ return 'rgba(170,190,210,0.6)'; }

// ---------- Boot ----------
(async function boot(){
  const ui = new UI();
  await ui.init();
  window.__NEON = { ui, engine: ui.engine, seq: ui.sequencer };
})();
