// Input Number Slider Combo Card
// Custom Lovelace card for Home Assistant
// Features: Hold-to-slide adjustment, configurable styling

/* global customElements, HTMLElement, window */

const HELP_URL = 'https://developers.home-assistant.io/docs/frontend/custom-ui/custom-card/';

class InputNumberSliderComboCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._config = undefined;
    this._hass = undefined;
    this._entity = undefined;
    this._value = undefined;
    this._isAdjusting = false;
    this._commitArmed = false;
    this._awaitingServiceResult = false;
    this._lastSentValue = undefined;
    this._showHoldSlider = false;
    this._holdTimer = null;
    this._holdStartX = 0;
    this._holdStartValue = 0;
    this._inputEl = null;
    this._isPressing = false;
    this._refocusAfterCommit = false;

    this._onKeydown = (e) => {
      if (e.key === 'Escape') this._cancelAdjust(true);
    };
    this._onGlobalClick = (e) => {
      if (!(this._isAdjusting && this._commitArmed)) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      const overlay = this.shadowRoot?.querySelector('.hold-slider-overlay');
      if (overlay && path.includes(overlay)) return;
      this._confirmAdjust(false);
    };
    this._onPointerMove = (e) => this._moveHold(e);
    this._onPointerUp = (e) => this._endHold(e);
  }

  static getConfigElement() {
    return document.createElement('input-number-slider-combo-card-editor');
  }

  static getStubConfig(hass) {
    const first = Object.keys(hass?.states || {}).find((e) => e.startsWith('input_number.'));
    return { entity: first || 'input_number.example', height: '30px' };
  }

  disconnectedCallback() {
    this._detachGlobalPointer();
  }

  setConfig(config) {
    if (!config) throw new Error('invalid config');
    if (config.entity && (typeof config.entity !== 'string' || !config.entity.startsWith('input_number.'))) {
      throw new Error('entity must be an input_number.*');
    }

    this._config = {
      height: undefined,
      input_background: undefined,
      underline: { thickness: undefined, color: 'var(--primary-color)' },
      show_hold_slider: false,
      hide_spinners: false,
      name: undefined,
      ...config,
    };

    const u = this._config.underline || {};
    this._config.underline = {
      thickness: typeof u.thickness === 'string' ? u.thickness : undefined,
      color: typeof u.color === 'string' ? u.color : 'var(--primary-color)',
    };

    this._render();
    this._applyGridOptions();
    this._notifyResize();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    const entity = hass.states[this._config.entity];
    this._entity = entity;
    if (!entity) return;
    
    const num = Number(entity.state);
    const attrsSig = this._attrsSignature(entity);
    const attrsChanged = this._lastAttrsSig !== attrsSig;
    
    if (!Number.isNaN(num)) {
      this._lastAttrsSig = attrsSig;
      const focusedEl = this.shadowRoot?.activeElement;
      const inputFocused = focusedEl?.classList?.contains('value-input');
      const inUserControl = this._isAdjusting || this._commitArmed || this._awaitingServiceResult;
      
      if (inUserControl) {
        if (this._awaitingServiceResult && this._lastSentValue !== undefined && num === this._lastSentValue) {
          this._value = num;
          this._awaitingServiceResult = false;
          this._isAdjusting = false;
          this._commitArmed = false;
          this._showHoldSlider = false;
          if (this._inputEl) {
            this._inputEl.readOnly = false;
            this._inputEl.classList.remove('no-select');
          }
          this._render();
          if (this._refocusAfterCommit) {
            this._refocusAfterCommit = false;
            requestAnimationFrame(() => {
              try { this._inputEl?.focus({ preventScroll: true }); } catch (_) { this._inputEl?.focus(); }
            });
          }
        }
        return;
      }

      const valueChanged = this._value !== num;
      this._value = num;
      if (attrsChanged) {
        this._render();
      } else if (valueChanged && !inputFocused) {
        this._renderValueOnly();
      }
    }
  }

  getCardSize() {
    const rows = Number(this._config?.grid_options?.rows);
    return (Number.isFinite(rows) && rows > 0) ? rows : 1;
  }

  _notifyResize() {
    try {
      this.dispatchEvent(new Event('ll-rebuild', { bubbles: true, composed: true }));
    } catch (_) {}
  }

  _applyGridOptions() {
    const rows = Number(this._config?.grid_options?.rows);
    if (Number.isFinite(rows) && rows > 0) {
      this.style.gridRow = `span ${rows}`;
      this.style.setProperty('--dashboard-card-span', rows);
      const card = this.shadowRoot?.querySelector('ha-card');
      if (card) {
        card.style.gridRow = `span ${rows}`;
        card.style.minHeight = 'unset';
        card.style.height = 'auto';
      }
    }
  }

  _getMin() {
    const { min } = this._entity?.attributes || {};
    return typeof min === 'number' ? min : Number(min ?? 0);
  }

  _getMax() {
    const { max } = this._entity?.attributes || {};
    return typeof max === 'number' ? max : Number(max ?? 100);
  }

  _getStep() {
    const { step } = this._entity?.attributes || {};
    const parsed = typeof step === 'number' ? step : Number(step ?? 1);
    return parsed > 0 ? parsed : 1;
  }

  _getUnit() {
    return this._entity?.attributes?.unit_of_measurement || '';
  }

  _getStepDecimals() {
    const step = this._getStep();
    if (!Number.isFinite(step)) return 0;
    const s = String(step);
    const idx = s.indexOf('.');
    return idx >= 0 ? (s.length - idx - 1) : 0;
  }

  _formatValueForDisplay() {
    const value = Number(this._value);
    if (!Number.isFinite(value)) return '';
    const decimals = this._getStepDecimals();
    return decimals > 0 ? value.toFixed(decimals) : String(value);
  }

  _callSetValue(newValue) {
    if (!this._hass || !this._config) return;
    const value = this._clampToRange(this._roundToStep(newValue));
    this._value = value;
    this._renderValueOnly();
    this._hass.callService('input_number', 'set_value', {
      entity_id: this._config.entity,
      value,
    });
  }

  _roundToStep(value) {
    const min = this._getMin();
    const step = this._getStep();
    const steps = Math.round((value - min) / step);
    const rounded = min + steps * step;
    return Number.isFinite(rounded) ? rounded : value;
  }

  _clampToRange(value) {
    return Math.min(Math.max(value, this._getMin()), this._getMax());
  }

  _onInputCommit(e) {
    const parsed = Number(e.currentTarget.value);
    if (!Number.isNaN(parsed)) {
      this._callSetValue(parsed);
    } else {
      this._render();
    }
  }

  _onSliderInput(e) {
    const val = Number(e.currentTarget.value);
    if (!Number.isNaN(val)) {
      this._value = val;
      this._renderValueOnly();
    }
  }

  _startHold(e) {
    this._cancelHold();
    this._holdStartX = e.clientX;
    this._holdStartValue = this._value ?? 0;
    this._attachGlobalPointer();
    this._isPressing = true;
    this._holdTimer = setTimeout(() => {
      this._isAdjusting = true;
      this._commitArmed = false;
      this._showHoldSlider = !!this._config.show_hold_slider;
      this._render();
      if (this._inputEl) {
        try { this._inputEl.blur(); } catch (_) {}
        this._inputEl.readOnly = true;
        this._inputEl.classList.add('no-select');
      }
      window.addEventListener('keydown', this._onKeydown, true);
    }, 350);
  }

  _moveHold(e) {
    if (!this._isAdjusting) return;
    if (e.cancelable) e.preventDefault();
    
    const card = this.shadowRoot.querySelector('ha-card');
    const rect = (card ? card.getBoundingClientRect() : this.getBoundingClientRect());
    const width = rect?.width > 0 ? rect.width : 1;
    const min = this._getMin();
    const max = this._getMax();
    const step = this._getStep();
    const stepsCount = Math.max(1, Math.round((max - min) / step));
    const pixelsPerStep = width / stepsCount;
    const deltaX = e.clientX - this._holdStartX;
    const deltaSteps = Math.round(deltaX / pixelsPerStep);
    const candidate = this._holdStartValue + deltaSteps * step;
    const clamped = this._clampToRange(this._roundToStep(candidate));
    
    if (clamped !== this._value) {
      this._value = clamped;
      this._renderValueOnly();
    }
  }

  _endHold(e) {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._isAdjusting) {
      this._commitArmed = true;
      if (this._config?.show_hold_slider) {
        this._confirmAdjust(false);
        return;
      }
    }
    this._detachGlobalPointer();
    if (this._inputEl && !this._isAdjusting) {
      this._inputEl.readOnly = false;
    }
    this._isPressing = false;
    if (this._isAdjusting && this._config?.show_hold_slider) {
      window.addEventListener('click', this._onGlobalClick, true);
    }
  }

  _cancelHold() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    this._detachGlobalPointer();
    if (this._inputEl && !this._isAdjusting) {
      this._inputEl.classList.remove('no-select');
    }
    this._isPressing = false;
  }

  _confirmAdjust(refocus = true) {
    if (!(this._isAdjusting && this._commitArmed)) return;
    this._awaitingServiceResult = true;
    this._lastSentValue = this._value;
    this._callSetValue(this._value);
    this._isAdjusting = false;
    this._commitArmed = false;
    this._showHoldSlider = false;
    if (this._inputEl) {
      this._inputEl.readOnly = false;
      this._inputEl.classList.remove('no-select');
    }
    this._refocusAfterCommit = !!refocus;
    window.removeEventListener('click', this._onGlobalClick, true);
    window.removeEventListener('keydown', this._onKeydown, true);
    this._render();
  }

  _cancelAdjust(restoreValue) {
    if (!this._isAdjusting) return;
    if (restoreValue) {
      this._value = this._holdStartValue;
      this._renderValueOnly();
    }
    this._isAdjusting = false;
    this._commitArmed = false;
    this._awaitingServiceResult = false;
    this._showHoldSlider = false;
    if (this._inputEl) {
      this._inputEl.readOnly = false;
      this._inputEl.classList.remove('no-select');
    }
    window.removeEventListener('click', this._onGlobalClick, true);
    window.removeEventListener('keydown', this._onKeydown, true);
    this._render();
  }

  _attachGlobalPointer() {
    window.addEventListener('pointermove', this._onPointerMove, { passive: false });
    window.addEventListener('pointerup', this._onPointerUp, { passive: true });
    window.addEventListener('pointercancel', this._onPointerUp, { passive: true });
  }

  _detachGlobalPointer() {
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
  }

  _renderValueOnly() {
    const haTf = this.shadowRoot?.querySelector('ha-textfield');
    if (haTf) {
      haTf.value = String(this._value ?? '');
      try { haTf.setAttribute('suffix', this._getUnit()); } catch (_) {}
    }
    const slider = this.shadowRoot?.querySelector('input[type="range"]');
    if (slider) slider.value = String(this._value ?? '');
    const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
    if (overlayVal) {
      overlayVal.textContent = `${this._formatValueForDisplay()} ${this._getUnit()}`.trim();
    }
  }

  _render() {
    if (!this.shadowRoot) return;
    const entity = this._entity;
    const name = this._config?.name || entity?.attributes?.friendly_name || this._config?.entity || '';
    const min = this._getMin();
    const max = this._getMax();
    const step = this._getStep();
    const unit = this._getUnit();
    const height = this._config?.height;
    const inputBg = this._config?.input_background;
    const underlineThickness = this._config?.underline?.thickness;
    const underlineColor = this._config?.underline?.color;

    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; }
      ha-card { padding: 12px 16px; }
      .row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 12px;
        ${height ? `min-height: ${height};` : ''}
      }
      .icon { color: var(--state-icon-color); cursor: pointer; }
      .name {
        color: var(--primary-text-color);
        font-size: 14px;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }
      .value-container {
        display: flex;
        align-items: center;
        gap: 6px;
        position: relative;
        touch-action: pan-y;
      }
      .underline {
        position: absolute;
        bottom: 0;
        right: 0;
        left: 0;
        ${underlineThickness ? `height: ${underlineThickness}; background: ${underlineColor}; opacity: 0.6;` : 'height: 0; background: transparent;'}
        pointer-events: none;
      }
      ha-textfield {
        ${inputBg ? `--mdc-text-field-fill-color: ${inputBg};` : ''}
      }
      .hold-slider-overlay {
        position: absolute;
        left: 16px;
        right: 16px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10;
        background: var(--card-background-color);
        padding: 6px 8px;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,.2);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .hold-slider-overlay input[type="range"] {
        flex: 1 1 auto;
        appearance: none;
        height: 4px;
        background: var(--primary-color);
        border-radius: 2px;
      }
      .hold-slider-overlay input[type="range"]::-webkit-slider-runnable-track {
        height: 4px;
        background: var(--primary-color);
        border-radius: 2px;
      }
      .hold-slider-overlay input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--primary-color);
        border: 2px solid var(--primary-color);
        margin-top: -5px;
      }
      .hold-slider-overlay input[type="range"]::-moz-range-track {
        height: 4px;
        background: var(--primary-color);
        border-radius: 2px;
      }
      .hold-slider-overlay input[type="range"]::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--primary-color);
        border: 2px solid var(--primary-color);
        border: none;
      }
      .overlay-value {
        flex: 0 0 auto;
        color: var(--primary-text-color);
        font-size: 14px;
        min-width: 3ch;
        text-align: right;
      }
      .help {
        color: var(--secondary-text-color);
        font-size: 12px;
        margin-top: 6px;
      }
    `;

    const card = document.createElement('ha-card');
    const row = document.createElement('div');
    row.className = 'row';

    // Icon
    const iconWrap = document.createElement('div');
    iconWrap.className = 'icon';
    if (entity) {
      const stateIcon = document.createElement('ha-state-icon');
      stateIcon.hass = this._hass;
      stateIcon.stateObj = entity;
      stateIcon.addEventListener('click', () => this._fireMoreInfo());
      iconWrap.appendChild(stateIcon);
    }

    // Name
    const left = document.createElement('div');
    left.className = 'name';
    left.textContent = name;
    left.addEventListener('click', () => this._fireMoreInfo());

    // Value container
    const right = document.createElement('div');
    right.className = 'value-container';

    // Input field
    const tf = document.createElement('ha-textfield');
    const hide = !!this._config?.hide_spinners;
    tf.type = hide ? 'text' : 'number';
    if (hide) {
      tf.setAttribute('inputmode', 'decimal');
      tf.style.width = '120px';
    }
    tf.value = String(this._value ?? '');
    tf.setAttribute('suffix', unit);
    tf.setAttribute('min', String(min));
    tf.setAttribute('max', String(max));
    tf.setAttribute('step', String(step));
    if (height) {
      tf.style.setProperty('--mdc-text-field-fill-height', height);
      tf.style.height = height;
    }
    tf.addEventListener('change', () => this._onInputCommit({ currentTarget: { value: tf.value } }));
    tf.addEventListener('pointerdown', (ev) => this._startHold(ev));
    this._inputEl = tf;

    const underline = document.createElement('div');
    underline.className = 'underline';

    right.appendChild(tf);
    right.appendChild(underline);

    // Confirmation click handler
    const confirmHandler = (ev) => {
      if (this._isAdjusting && this._commitArmed) {
        this._awaitingServiceResult = true;
        this._lastSentValue = this._value;
        this._callSetValue(this._value);
        this._isAdjusting = false;
        this._commitArmed = false;
        this._showHoldSlider = false;
        if (this._inputEl) {
          this._inputEl.readOnly = false;
          this._inputEl.classList.remove('no-select');
          requestAnimationFrame(() => {
            try { this._inputEl.focus({ preventScroll: true }); } catch (_) { this._inputEl.focus(); }
          });
        }
        this._refocusAfterCommit = true;
      } else if (this._inputEl) {
        try { this._inputEl.focus({ preventScroll: true }); } catch (_) { this._inputEl.focus(); }
      }
    };
    right.addEventListener('click', confirmHandler, { capture: true });
    tf.addEventListener('click', confirmHandler, { capture: true });

    // Hold slider overlay
    if (this._showHoldSlider) {
      const overlay = document.createElement('div');
      overlay.className = 'hold-slider-overlay';
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(this._value ?? '');
      slider.addEventListener('input', (e) => this._onSliderInput(e));
      overlay.appendChild(slider);
      const overlayValue = document.createElement('span');
      overlayValue.className = 'overlay-value';
      overlayValue.textContent = `${this._formatValueForDisplay()} ${unit}`.trim();
      overlay.appendChild(overlayValue);
      card.appendChild(overlay);
    }

    row.appendChild(iconWrap);
    row.appendChild(left);
    row.appendChild(right);
    card.appendChild(row);

    // Entity not found help
    if (!entity) {
      const help = document.createElement('div');
      help.className = 'help';
      help.textContent = 'Entity not found. Check entity id in card config.';
      card.appendChild(help);
    }

    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(card);
  }

  _attrsSignature(entity) {
    if (!entity) return '';
    const a = entity.attributes || {};
    return [a.min, a.max, a.step, a.unit_of_measurement].join('|');
  }

  _fireMoreInfo() {
    if (!this._config?.entity) return;
    const ev = new CustomEvent('hass-more-info', {
      bubbles: true,
      composed: true,
      detail: { entityId: this._config.entity },
    });
    this.dispatchEvent(ev);
  }
}

customElements.define('input-number-slider-combo-card', InputNumberSliderComboCard);

// Card picker registration
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'input-number-slider-combo-card',
  name: 'Input Number Slider Combo Card',
  description: 'input_number card with hold-to-slide adjustment',
  preview: false,
  documentationURL: HELP_URL,
});

// Editor
if (!customElements.get('input-number-slider-combo-card-editor')) {
  class InputNumberSliderComboCardEditor extends HTMLElement {
    constructor() {
      super();
      this._depsReady = false;
    }

    setConfig(config) {
      this._config = {
        show_hold_slider: false,
        underline: { thickness: undefined, color: 'var(--primary-color)' },
        name: undefined,
        ...config,
      };
      this._ensureEditorDeps();
      this._render();
    }

    set hass(hass) {
      this._hass = hass;
      if (this._config && !this._depsReady) {
        this._ensureEditorDeps();
      }
    }

    _emitConfig(config) {
      const ev = new CustomEvent('config-changed', {
        detail: { config },
        bubbles: true,
        composed: true,
      });
      this.dispatchEvent(ev);
    }

    async _ensureEditorDeps() {
      if (this._depsReady) return;
      const wasReady = this._depsReady;
      try {
        if (window.loadCardHelpers) {
          const helpers = await window.loadCardHelpers();
          if (helpers?.createCardElement) {
            const entitiesCard = await helpers.createCardElement({ type: 'entities', entities: [] });
            if (entitiesCard?.constructor?.getConfigElement) {
              await entitiesCard.constructor.getConfigElement();
            }
          }
        }
      } catch (_) {}
      this._depsReady = true;
      if (!wasReady) this._render();
    }

    _onTextChange(e) {
      const t = e.currentTarget;
      const key = t.dataset.key;
      const value = t.value;
      if (key === 'underline.thickness' || key === 'underline.color') {
        const [, sub] = key.split('.');
        this._config.underline = { ...this._config.underline, [sub]: value };
      } else if (key === 'height' || key === 'input_background' || key === 'name') {
        this._config[key] = value || undefined;
      }
      this._emitConfig(this._config);
    }

    _render() {
      this.innerHTML = '';
      const root = document.createElement('div');
      root.style.display = 'grid';
      root.style.gap = '12px';

      const mkRow = (label, input) => {
        const row = document.createElement('div');
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '160px 1fr';
        row.style.alignItems = 'center';
        const l = document.createElement('label');
        l.textContent = label;
        row.appendChild(l);
        row.appendChild(input);
        return row;
      };

      // Entity picker
      const picker = document.createElement('ha-entity-picker');
      picker.hass = this._hass;
      picker.value = this._config.entity || '';
      picker.includeDomains = ['input_number'];
      picker.addEventListener('value-changed', (ev) => {
        this._config.entity = ev.detail.value || '';
        this._emitConfig(this._config);
      });
      root.appendChild(mkRow('Entity', picker));

      // Name
      const name = document.createElement('ha-textfield');
      name.label = 'Name (optional)';
      name.value = this._config.name || '';
      name.dataset.key = 'name';
      name.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Name', name));

      // Height
      const height = document.createElement('ha-textfield');
      height.label = 'Height (e.g. 30px)';
      height.value = this._config.height || '';
      height.dataset.key = 'height';
      height.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Height', height));

      // Input background
      const bg = document.createElement('ha-textfield');
      bg.label = 'Input background (CSS color)';
      bg.value = this._config.input_background || '';
      bg.dataset.key = 'input_background';
      bg.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Input background', bg));

      // Underline thickness
      const uTh = document.createElement('ha-textfield');
      uTh.label = 'Underline thickness (e.g. 2px)';
      uTh.value = (this._config.underline?.thickness) || '';
      uTh.dataset.key = 'underline.thickness';
      uTh.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Underline thickness', uTh));

      // Underline color
      const uCol = document.createElement('ha-textfield');
      uCol.label = 'Underline color (CSS)';
      uCol.value = (this._config.underline?.color) || '';
      uCol.dataset.key = 'underline.color';
      uCol.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Underline color', uCol));

      // Show hold slider
      const show = document.createElement('ha-switch');
      show.checked = !!this._config.show_hold_slider;
      show.addEventListener('change', (e) => {
        this._config.show_hold_slider = e.currentTarget.checked;
        this._emitConfig(this._config);
      });
      root.appendChild(mkRow('Show slider on hold', show));

      // Hide spinners
      const hide = document.createElement('ha-switch');
      hide.checked = !!this._config.hide_spinners;
      hide.addEventListener('change', (e) => {
        this._config.hide_spinners = e.currentTarget.checked;
        this._emitConfig(this._config);
      });
      root.appendChild(mkRow('Hide spinners', hide));

      this.appendChild(root);
    }
  }
  customElements.define('input-number-slider-combo-card-editor', InputNumberSliderComboCardEditor);
}