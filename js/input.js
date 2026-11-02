/**
 * Unified keyboard + touch input.
 *
 * Touch is swipe-only by design: swipes are registered against a dead zone so
 * a tap cannot fire a turn, and the direction is chosen from the dominant axis
 * so a sloppy diagonal still produces a predictable 90-degree turn.
 */
import { GAME_KEYS } from './config.js';

const SWIPE_THRESHOLD_PX = 20;
const TAP_MAX_DURATION_MS = 250;

export class InputController {
  /**
   * @param {object} options
   * @param {HTMLElement} options.target element that receives pointer events
   * @param {(direction:{x:number,y:number}) => void} options.onDirection
   * @param {() => void} [options.onPause]
   * @param {() => void} [options.onTap]
   * @param {() => void} [options.onFirstInput]
   */
  constructor(options = {}) {
    this.target = options.target || document.body;
    this.onDirection = options.onDirection || (() => {});
    this.onPause = options.onPause || (() => {});
    this.onTap = options.onTap || (() => {});
    this.onFirstInput = options.onFirstInput || (() => {});
    this.enabled = false;
    this.pointerActive = false;
    this.pointerId = null;
    this.startX = 0;
    this.startY = 0;
    this.startTime = 0;
    this.lastX = 0;
    this.lastY = 0;
    this.swipeFired = false;
    this.axisLock = null;
    this.sawFirstInput = false;
    this.keyRepeatGuard = new Set();

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerCancel = this._handlePointerCancel.bind(this);
    this._onContextMenu = (event) => event.preventDefault();
    this._onTouchScroll = (event) => {
      if (this.enabled) event.preventDefault();
    };
  }

  attach() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    const target = this.target;
    target.addEventListener('pointerdown', this._onPointerDown, { passive: false });
    target.addEventListener('pointermove', this._onPointerMove, { passive: false });
    target.addEventListener('pointerup', this._onPointerUp, { passive: false });
    target.addEventListener('pointercancel', this._onPointerCancel, { passive: false });
    target.addEventListener('contextmenu', this._onContextMenu);
    target.addEventListener('touchmove', this._onTouchScroll, { passive: false });
    target.addEventListener('dragstart', this._onContextMenu);
    return this;
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    const target = this.target;
    target.removeEventListener('pointerdown', this._onPointerDown);
    target.removeEventListener('pointermove', this._onPointerMove);
    target.removeEventListener('pointerup', this._onPointerUp);
    target.removeEventListener('pointercancel', this._onPointerCancel);
    target.removeEventListener('contextmenu', this._onContextMenu);
    target.removeEventListener('touchmove', this._onTouchScroll);
    target.removeEventListener('dragstart', this._onContextMenu);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.pointerActive = false;
      this.pointerId = null;
      this.axisLock = null;
    }
  }

  _noteFirstInput() {
    if (this.sawFirstInput) return;
    this.sawFirstInput = true;
    this.onFirstInput();
  }

  _handleKeyDown(event) {
    const code = event.code;
    if (!this.enabled && !GAME_KEYS.includes(code)) return;

    // Always stop browser scrolling for gameplay keys, even when the game is
    // paused, so the page never jumps mid-run.
    if (GAME_KEYS.includes(code)) event.preventDefault();

    if (event.repeat) return;
    if (this.keyRepeatGuard.has(code)) return;
    this.keyRepeatGuard.add(code);

    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        this._noteFirstInput();
        this.onDirection({ x: 0, y: -1 });
        break;
      case 'ArrowDown':
      case 'KeyS':
        this._noteFirstInput();
        this.onDirection({ x: 0, y: 1 });
        break;
      case 'ArrowLeft':
      case 'KeyA':
        this._noteFirstInput();
        this.onDirection({ x: -1, y: 0 });
        break;
      case 'ArrowRight':
      case 'KeyD':
        this._noteFirstInput();
        this.onDirection({ x: 1, y: 0 });
        break;
      case 'Space':
      case 'Escape':
      case 'KeyP':
        this.onPause();
        break;
      default:
        break;
    }
  }

  _handleKeyUp(event) {
    this.keyRepeatGuard.delete(event.code);
  }

  _handlePointerDown(event) {
    if (!this.enabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    this._noteFirstInput();
    this.pointerActive = true;
    this.pointerId = event.pointerId;
    this.startX = event.clientX;
    this.startY = event.clientY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.startTime = event.timeStamp || Date.now();
    this.swipeFired = false;
    this.axisLock = null;
    if (this.target.setPointerCapture && event.pointerId != null) {
      try {
        this.target.setPointerCapture(event.pointerId);
      } catch {
        // Non-fatal: capture is a nicety for dragging off the board.
      }
    }
  }

  _handlePointerMove(event) {
    if (!this.enabled || !this.pointerActive) return;
    event.preventDefault();
    const dx = event.clientX - this.startX;
    const dy = event.clientY - this.startY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;

    const distance = Math.hypot(dx, dy);
    if (distance < SWIPE_THRESHOLD_PX) return;

    // Lock to the dominant axis on the first meaningful movement so a long
    // drag cannot produce two turns in quick succession.
    if (!this.axisLock) {
      this.axisLock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    const primary = this.axisLock === 'x' ? dx : dy;
    if (Math.abs(primary) < SWIPE_THRESHOLD_PX) return;

    const direction =
      this.axisLock === 'x'
        ? { x: primary > 0 ? 1 : -1, y: 0 }
        : { x: 0, y: primary > 0 ? 1 : -1 };

    if (this.swipeFired) {
      // A single continuous drag may queue one extra turn after the finger
      // crosses another dead zone, which makes tight corners feel responsive.
      const travelled = Math.hypot(this.lastX - this.startX, this.lastY - this.startY);
      if (travelled < SWIPE_THRESHOLD_PX * 2.4) return;
    }
    this.swipeFired = true;
    this.startX = this.lastX;
    this.startY = this.lastY;
    this.axisLock = null;
    this.onDirection(direction);
  }

  _handlePointerUp(event) {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    this.pointerId = null;
    if (!this.swipeFired) {
      const duration = (event.timeStamp || Date.now()) - this.startTime;
      const distance = Math.hypot(event.clientX - this.startX, event.clientY - this.startY);
      if (duration <= TAP_MAX_DURATION_MS && distance < SWIPE_THRESHOLD_PX) {
        this.onTap();
      }
    }
    this.axisLock = null;
    this.swipeFired = false;
  }

  _handlePointerCancel() {
    this.pointerActive = false;
    this.pointerId = null;
    this.axisLock = null;
    this.swipeFired = false;
  }
}

export { SWIPE_THRESHOLD_PX };
