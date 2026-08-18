/*
 * Read-along player for a Wallabag entry.
 *
 * Audio is one pre-rendered MP3 served by the wallabag-tts service, assigned
 * once to a single <audio> element. That shape matters: it is the only one
 * known to keep playing on Android with the screen off. Sequencing chunks
 * client-side while backgrounded is precisely what fails, so the client never
 * does it -- if an article is not rendered yet, it waits rather than streaming.
 */

import { markSentences, sentenceSpans } from './sentences';
import './tts.scss';

const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

function fmt(rawSeconds) {
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

class Player {
  constructor(cfg, root) {
    this.cfg = cfg;
    this.root = root;
    this.article = document.querySelector('#article article')
                   || document.querySelector('#article');
    this.audio = document.getElementById('tts-audio');
    this.toggle = document.getElementById('tts-toggle');
    this.statusEl = document.getElementById('tts-status');
    this.seek = document.getElementById('tts-seek');
    this.curEl = document.getElementById('tts-current');
    this.durEl = document.getElementById('tts-duration');
    this.followBtn = document.getElementById('tts-follow');
    this.rateSel = document.getElementById('tts-rate');
    this.voiceSel = document.getElementById('tts-voice');
    this.regenBtn = document.getElementById('tts-regen');

    this.timings = null;
    this.current = -1;
    this.follow = true;
    this.marked = false;
    this.seeking = false;
    this.lastSave = 0;
    this.posKey = `tts:pos:${cfg.entryId}`;
    this.ratePref = 'tts:rate';
    // Voice is a global preference, not per-article: picking one and then
    // opening the next article should keep it.
    this.voicePref = 'tts:voice';
    this.voice = window.localStorage.getItem(this.voicePref) || '';
  }

  url(path, extra) {
    const base = `${this.cfg.base.replace(/\/$/, '')}/entry/${this.cfg.entryId}${path}`;
    const params = new URLSearchParams(extra || {});
    // Omit when empty so the service applies its configured default rather
    // than being handed a blank voice.
    if (this.voice) params.set('voice', this.voice);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  status(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  // -- lifecycle ---------------------------------------------------------

  init() {
    if (!this.article || !this.audio) return;

    this.toggle.addEventListener('click', () => this.onToggle());
    this.followBtn.addEventListener('click', () => this.setFollow(!this.follow));

    const savedRate = window.localStorage.getItem(this.ratePref);
    if (savedRate) {
      this.rateSel.value = savedRate;
      this.audio.playbackRate = parseFloat(savedRate);
    }
    this.rateSel.addEventListener('change', () => {
      const r = parseFloat(this.rateSel.value);
      this.audio.playbackRate = r;
      window.localStorage.setItem(this.ratePref, String(r));
    });

    this.audio.addEventListener('timeupdate', () => this.onTime());
    this.audio.addEventListener('play', () => this.onPlayState(true));
    this.audio.addEventListener('pause', () => this.onPlayState(false));
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('loadedmetadata', () => this.onMeta());
    this.audio.addEventListener('error', () => {
      this.status(this.cfg.strings.error);
    });

    this.seek.addEventListener('input', () => {
      this.seeking = true;
      this.curEl.textContent = fmt(parseFloat(this.seek.value));
    });
    this.seek.addEventListener('change', () => {
      this.audio.currentTime = parseFloat(this.seek.value);
      this.seeking = false;
    });

    this.voiceSel.addEventListener('change', () => this.onVoiceChange());
    this.regenBtn.addEventListener('click', () => this.onRegenerate());

    // Persist position often enough that closing the tab mid-article resumes
    // where it left off. 'pagehide' rather than 'unload': the latter does not
    // fire reliably on mobile Safari or when a tab is discarded.
    window.addEventListener('pagehide', () => this.savePos());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.savePos();
    });

    this.loadVoices();
    this.refreshStatus();
  }

  async loadVoices() {
    try {
      const res = await fetch(
        `${this.cfg.base.replace(/\/$/, '')}/voices`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) throw new Error(`voices ${res.status}`);
      const body = await res.json();
      const names = body.voices || [];
      if (!names.length) throw new Error('empty voice list');
      this.voiceSel.innerHTML = '';
      names.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        // Strip the sample-file extension; it is an implementation detail of
        // how the voice was cloned, not something to read in a dropdown.
        opt.textContent = name.replace(/\.(wav|mp3|flac|ogg)$/i, '');
        this.voiceSel.appendChild(opt);
      });
      // A stored voice the server no longer offers must not silently persist,
      // or every render would 400 on an unknown voice.
      if (this.voice && names.indexOf(this.voice) === -1) {
        this.voice = '';
        window.localStorage.removeItem(this.voicePref);
      }
      this.voiceSel.value = this.voice || body.default || names[0];
      this.voice = this.voiceSel.value;
    } catch (e) {
      // Voice switching is a convenience; playback still works on the default.
      this.voiceSel.style.display = 'none';
    }
  }

  async onVoiceChange() {
    const next = this.voiceSel.value;
    if (next === this.voice) return;
    this.voice = next;
    window.localStorage.setItem(this.voicePref, next);
    // A different voice is a different recording, so everything derived from
    // the old one is discarded rather than reused.
    this.resetAudio();
    await this.refreshStatus();
  }

  async onRegenerate() {
    if (!window.confirm(this.cfg.strings.regenerate)) return;
    this.resetAudio();
    window.localStorage.removeItem(this.posKey);
    this.status(this.cfg.strings.queued);
    await fetch(this.url('/render', { force: 'true' }), {
      method: 'POST', credentials: 'same-origin',
    }).catch(() => {});
    const st = await this.waitUntilReady();
    if (st) await this.refreshStatus();
  }

  /* Drop the loaded recording and every artefact derived from it. The sentence
   * spans stay in the DOM -- they are a property of the article text, not of
   * the audio, and re-marking would nest spans inside spans. */
  resetAudio() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.timings = null;
    this.highlight(-1);
    this.seek.value = '0';
    this.curEl.textContent = fmt(0);
    this.durEl.textContent = fmt(0);
  }

  async refreshStatus() {
    try {
      const res = await fetch(this.url('/status'), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const st = await res.json();
      this.applyStatus(st);
      return st;
    } catch (e) {
      this.status(this.cfg.strings.error);
      return null;
    }
  }

  applyStatus(st) {
    this.root.dataset.state = st.state;
    if (st.state === 'ready') {
      this.status(this.cfg.strings.ready);
      if (st.duration_ms) this.durEl.textContent = fmt(st.duration_ms / 1000);
    } else if (st.state === 'rendering') {
      const pct = Math.round((st.progress || 0) * 100);
      this.status(`${this.cfg.strings.preparing} ${pct}%`);
    } else if (st.state === 'queued') {
      this.status(this.cfg.strings.queued);
    } else if (st.state === 'error') {
      this.status(this.cfg.strings.error + (st.error ? `: ${st.error}` : ''));
    } else {
      this.status(this.cfg.strings.idle);
    }
  }

  // -- playback ----------------------------------------------------------

  async onToggle() {
    if (!this.audio.paused) {
      this.audio.pause();
      return;
    }
    if (this.audio.src) {
      this.audio.play().catch(() => this.status(this.cfg.strings.error));
      return;
    }

    let st = await this.refreshStatus();
    if (!st) return;

    if (st.state !== 'ready') {
      // Not pre-rendered: ask for it ahead of any backfill, then wait. The
      // click is the user gesture that authorises later playback, so autoplay
      // still succeeds when the render lands.
      if (st.state === 'absent' || st.state === 'error') {
        await fetch(this.url('/render'), {
          method: 'POST', credentials: 'same-origin',
        }).catch(() => {});
      }
      st = await this.waitUntilReady();
      if (!st) return;
    }
    await this.load();
    this.audio.play().catch(() => this.status(this.cfg.strings.error));
  }

  waitUntilReady() {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const tick = async () => {
        const st = await this.refreshStatus();
        if (!st) return resolve(null);
        if (st.state === 'ready') return resolve(st);
        if (st.state === 'error') return resolve(null);
        if (Date.now() > deadline) {
          this.status(this.cfg.strings.error);
          return resolve(null);
        }
        window.setTimeout(tick, POLL_MS);
        return undefined;
      };
      tick();
    });
  }

  async load() {
    if (!this.timings) {
      const res = await fetch(this.url('/timings.json'), { credentials: 'same-origin' });
      this.timings = await res.json();
    }
    if (!this.marked) {
      const r = markSentences(this.article, this.timings.sentences);
      this.marked = true;
      if (r.matched < r.total) {
        // Not fatal -- unmatched sentences simply are not highlighted, and
        // audio still plays. Logged because a large shortfall means the
        // extraction rules drifted from SKIP_TAGS on the server.
        window.console.warn(
          `[tts] highlighted ${r.matched}/${r.total} sentences`,
        );
      }
    }
    this.audio.src = this.url('/audio.mp3');
    const saved = parseFloat(window.localStorage.getItem(this.posKey) || '0');
    if (saved > 0) this.audio.currentTime = saved;
    this.setupMediaSession();
  }

  onMeta() {
    const d = this.audio.duration;
    if (Number.isFinite(d)) {
      this.seek.max = String(Math.floor(d));
      this.durEl.textContent = fmt(d);
    }
  }

  onPlayState(playing) {
    this.root.dataset.playing = playing ? '1' : '0';
    const icon = this.toggle.querySelector('i');
    if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
    this.toggle.setAttribute('aria-label', playing ? this.cfg.strings.pause : this.cfg.strings.play);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
    if (!playing) this.savePos();
  }

  onEnded() {
    window.localStorage.removeItem(this.posKey);
    this.highlight(-1);
  }

  onTime() {
    const t = this.audio.currentTime;
    if (!this.seeking) {
      this.seek.value = String(Math.floor(t));
      this.curEl.textContent = fmt(t);
    }
    this.highlight(this.indexAt(t * 1000));
    if (this.audio.currentTime - this.lastSave > 5) {
      this.lastSave = this.audio.currentTime;
      this.savePos();
    }
    this.updatePositionState();
  }

  /* Binary search the timing map; a long article is thousands of sentences and
   * this runs on every timeupdate. */
  indexAt(ms) {
    const s = this.timings ? this.timings.sentences : null;
    if (!s || !s.length) return -1;
    let lo = 0;
    let hi = s.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ms < s[mid].start_ms) {
        hi = mid - 1;
      } else if (ms >= s[mid].end_ms) {
        lo = mid + 1;
      } else {
        found = mid;
        break;
      }
    }
    return found;
  }

  highlight(index) {
    if (index === this.current) return;
    if (this.current >= 0) {
      sentenceSpans(this.article, this.current)
        .forEach((el) => el.classList.remove('tts-active'));
    }
    this.current = index;
    if (index < 0) return;
    const spans = sentenceSpans(this.article, index);
    spans.forEach((el) => el.classList.add('tts-active'));
    if (this.follow && spans.length) {
      const rect = spans[0].getBoundingClientRect();
      const margin = window.innerHeight * 0.25;
      if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
        spans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  setFollow(on) {
    this.follow = on;
    this.followBtn.classList.toggle('tts-on', on);
  }

  savePos() {
    if (this.audio && this.audio.currentTime > 0) {
      window.localStorage.setItem(this.posKey, String(this.audio.currentTime));
    }
  }

  // -- lock screen -------------------------------------------------------

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: this.cfg.title || document.title,
      artist: this.cfg.domain || 'wallabag',
      album: 'wallabag',
    });
    const skip = (delta) => {
      this.audio.currentTime = Math.max(0, this.audio.currentTime + delta);
    };
    navigator.mediaSession.setActionHandler('play', () => this.audio.play());
    navigator.mediaSession.setActionHandler('pause', () => this.audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15));
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30));
    navigator.mediaSession.setActionHandler('previoustrack', () => this.jump(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => this.jump(1));
    try {
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if (d.fastSeek && this.audio.fastSeek) this.audio.fastSeek(d.seekTime);
        else this.audio.currentTime = d.seekTime;
      });
    } catch (e) {
      // Older browsers reject unknown actions; seeking still works via the bar.
    }
  }

  /* Sentence-granular skip. Nicer than a fixed interval for prose, and it is
   * what makes the lock-screen next/previous buttons feel like chapters. */
  jump(delta) {
    if (!this.timings) return;
    const idx = this.indexAt(this.audio.currentTime * 1000);
    const next = Math.min(
      Math.max((idx < 0 ? 0 : idx) + delta, 0),
      this.timings.sentences.length - 1,
    );
    this.audio.currentTime = this.timings.sentences[next].start_ms / 1000;
  }

  /* Keeps the lock-screen scrubber honest; without it Android shows a position
   * that does not move. */
  updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: this.audio.playbackRate,
        position: Math.min(this.audio.currentTime, d),
      });
    } catch (e) {
      // Throws if position > duration during a seek; harmless.
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const island = document.getElementById('ttsroutes');
  const root = document.getElementById('tts-player');
  if (!island || !root) return;
  let cfg;
  try {
    cfg = JSON.parse(island.textContent);
  } catch (e) {
    return;
  }
  new Player(cfg, root).init();
});
