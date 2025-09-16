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
    this._timeComponent = null;
    this._isEmbedded = false;
    this._rafIds = new Set();

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
    const inputNumber = Object.keys(hass?.states || {}).find((e) => e.startsWith('input_number.'));
    const number = Object.keys(hass?.states || {}).find((e) => e.startsWith('number.'));
    const inputDatetime = Object.keys(hass?.states || {}).find((e) => e.startsWith('input_datetime.'));
    const inputSelect = Object.keys(hass?.states || {}).find((e) => e.startsWith('input_select.'));
    const select = Object.keys(hass?.states || {}).find((e) => e.startsWith('select.'));
    const first = inputNumber || number || inputDatetime || inputSelect || select;
    return { entity: first || 'input_number.example', height: '30px' };
  }

  connectedCallback() {
    // Check embedding status when connected to DOM
    setTimeout(() => this._checkEmbedding(), 0);
  }

  disconnectedCallback() {
    this._detachGlobalPointer();
    this._cancelAllRafs();
  }

  _checkEmbedding() {
    const wasEmbedded = this._isEmbedded;
    this._isEmbedded = this._isEmbeddedInEntitiesCard();
    
    // Re-render if embedding status changed
    if (wasEmbedded !== this._isEmbedded && this._config) {
      this._render();
    }
  }

  _isEmbeddedInEntitiesCard() {
    // Check if we're inside an entities card by looking for specific patterns
    let parent = this.parentElement;
    while (parent && parent !== document.body) {
      // Check for entities card patterns
      if (parent.tagName && (
          parent.tagName.includes('ENTITIES') ||
          parent.tagName === 'HUI-ENTITY-ROW' ||
          (parent.className && parent.className.includes('entities'))
      )) {
        return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  setConfig(config) {
    if (!config) throw new Error('invalid config');
    if (config.entity && typeof config.entity === 'string') {
      const validPrefixes = ['input_number.', 'number.', 'input_datetime.', 'input_select.', 'select.'];
      if (!validPrefixes.some(prefix => config.entity.startsWith(prefix))) {
        throw new Error('entity must be an input_number.*, number.*, input_datetime.*, input_select.*, or select.*');
      }
    }

    this._config = {
      height: undefined,
      input_background: undefined,
      width: undefined,
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
    
    const entityType = this._getEntityType();
    let currentValue = entity.state;
    
    // Handle different entity types
    if (entityType === 'input_number') {
      const num = Number(entity.state);
      if (Number.isNaN(num)) return;
      currentValue = num;
    } else if (entityType === 'input_datetime') {
      // input_datetime state can be date, time, or datetime - extract time part
      if (entity.state.includes(' ')) {
        // datetime format: "2023-12-25 14:30:00" -> "14:30"
        currentValue = entity.state.split(' ')[1].substring(0, 5);
      } else if (entity.state.includes(':')) {
        // time format: "14:30:00" -> "14:30"
        currentValue = entity.state.substring(0, 5);
      } else {
        // date only - not supported for our time inputs
        currentValue = '00:00';
      }
    } else if (entityType === 'input_select') {
      // input_select state is the selected option
      currentValue = entity.state;
    }
    
    const attrsSig = this._attrsSignature(entity);
    const attrsChanged = this._lastAttrsSig !== attrsSig;
    this._lastAttrsSig = attrsSig;
    
    const focusedEl = this.shadowRoot?.activeElement;
    const inputFocused = focusedEl?.classList?.contains('value-input');
    const inUserControl = this._isAdjusting || this._commitArmed || this._awaitingServiceResult;
    
    if (inUserControl) {
      if (this._awaitingServiceResult && this._lastSentValue !== undefined && 
          ((entityType === 'input_number' && currentValue === this._lastSentValue) ||
           (entityType !== 'input_number' && currentValue === this._lastSentValue))) {
        this._value = currentValue;
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
          this._scheduleRaf(() => {
            try { this._inputEl?.focus({ preventScroll: true }); } catch (_) { this._inputEl?.focus(); }
          });
        }
      }
      return;
    }

    const valueChanged = this._value !== currentValue;
    this._value = currentValue;
    if (attrsChanged) {
      this._render();
    } else if (valueChanged && !inputFocused) {
      this._renderValueOnly();
    }
  }

  getCardSize() {
    const rows = Number(this._config?.grid_options?.rows);
    return (Number.isFinite(rows) && rows > 0) ? rows : 1;
  }

  _getEntityType() {
    if (!this._config?.entity) return 'input_number';
    if (this._config.entity.startsWith('input_datetime.')) return 'input_datetime';
    if (this._config.entity.startsWith('input_select.')) return 'input_select';
    if (this._config.entity.startsWith('select.')) return 'input_select';
    if (this._config.entity.startsWith('number.')) return 'input_number';
    return 'input_number';
  }

  _isStandalone() {
    // Use cached embedding status
    return !this._isEmbedded;
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
      const container = this.shadowRoot?.querySelector(this._isStandalone() ? 'ha-card' : 'div');
      if (container) {
        container.style.gridRow = `span ${rows}`;
        container.style.minHeight = 'unset';
        container.style.height = 'auto';
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

  _getSelectOptions() {
    return this._entity?.attributes?.options || [];
  }

  _parseTimeValue(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return { hours: 0, minutes: 0 };
    const parts = timeStr.split(':');
    return {
      hours: parseInt(parts[0]) || 0,
      minutes: parseInt(parts[1]) || 0
    };
  }

  _formatTimeValue(hours, minutes) {
    const h = String(hours).padStart(2, '0');
    const m = String(minutes).padStart(2, '0');
    return `${h}:${m}`;
  }

  _getStepDecimals() {
    const step = this._getStep();
    if (!Number.isFinite(step)) return 0;
    const s = String(step);
    const idx = s.indexOf('.');
    return idx >= 0 ? (s.length - idx - 1) : 0;
  }

  _formatValueForDisplay() {
    const entityType = this._getEntityType();
    
    if (entityType === 'input_number') {
      const value = Number(this._value);
      if (!Number.isFinite(value)) return '';
      const decimals = this._getStepDecimals();
      return decimals > 0 ? value.toFixed(decimals) : String(value);
    } else if (entityType === 'input_datetime') {
      return String(this._value || '00:00');
    } else if (entityType === 'input_select') {
      return String(this._value || '');
    }
    
    return String(this._value || '');
  }

  _callSetValue(newValue) {
    if (!this._hass || !this._config) return;
    const entityType = this._getEntityType();
    
    if (entityType === 'input_number') {
      const value = this._clampToRange(this._roundToStep(newValue));
      this._value = value;
      this._renderValueOnly();
      
      // Use appropriate service based on entity prefix
      if (this._config.entity.startsWith('number.')) {
        this._hass.callService('number', 'set_value', {
          entity_id: this._config.entity,
          value,
        });
      } else {
        this._hass.callService('input_number', 'set_value', {
          entity_id: this._config.entity,
          value,
        });
      }
    } else if (entityType === 'input_datetime') {
      this._value = newValue;
      this._renderValueOnly();
      this._hass.callService('input_datetime', 'set_datetime', {
        entity_id: this._config.entity,
        time: newValue,
      });
    } else if (entityType === 'input_select') {
      // Use appropriate service based on entity prefix
      if (this._config.entity.startsWith('select.')) {
        this._hass.callService('select', 'select_option', {
          entity_id: this._config.entity,
          option: newValue,
        });
      } else {
        this._hass.callService('input_select', 'select_option', {
          entity_id: this._config.entity,
          option: newValue,
        });
      }
    }
  }

  _roundToStep(value) {
    const min = this._getMin();
    const step = this._getStep();
    const steps = Math.round((value - min) / step);
    const rounded = min + steps * step;
    
    if (!Number.isFinite(rounded)) return value;
    
    // Fix floating point precision errors by rounding to step decimals
    const decimals = this._getStepDecimals();
    return decimals > 0 ? Number(rounded.toFixed(decimals)) : rounded;
  }

  _clampToRange(value) {
    return Math.min(Math.max(value, this._getMin()), this._getMax());
  }

  _onInputCommit(e) {
    const entityType = this._getEntityType();
    const value = e.currentTarget.value;
    
    if (entityType === 'input_number') {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        this._callSetValue(parsed);
      } else {
        this._render();
      }
    } else if (entityType === 'input_datetime' || entityType === 'input_select') {
      this._callSetValue(value);
    }
  }

  _onSliderInput(e) {
    const val = Number(e.currentTarget.value);
    if (!Number.isNaN(val)) {
      this._value = val;
      this._renderValueOnly();
    }
  }

  _onTimeSliderInput(e) {
    const val = Number(e.currentTarget.value);
    if (!Number.isNaN(val) && this._timeComponent) {
      const { hours, minutes } = this._parseTimeValue(this._value);
      let newHours = hours;
      let newMinutes = minutes;
      
      if (this._timeComponent === 'hours') {
        newHours = val;
      } else if (this._timeComponent === 'minutes') {
        newMinutes = val;
      }
      
      this._value = this._formatTimeValue(newHours, newMinutes);
      this._renderValueOnly();
    }
  }

  _onSelectSliderInput(e) {
    const val = Number(e.currentTarget.value);
    if (!Number.isNaN(val)) {
      const options = this._getSelectOptions();
      const index = Math.max(0, Math.min(options.length - 1, val));
      const newValue = options[index];
      if (newValue) {
        // Only update overlay display, don't change actual value until release
        const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
        if (overlayVal) {
          overlayVal.textContent = newValue;
        }
      }
    }
  }

  _startHold(e) {
    this._cancelHold();
    this._holdStartX = e.clientX;
    const entityType = this._getEntityType();
    
    if (entityType === 'input_select') {
      const options = this._getSelectOptions();
      const currentIndex = options.indexOf(this._value);
      this._holdStartValue = currentIndex >= 0 ? currentIndex : 0;
    } else {
      this._holdStartValue = this._value ?? 0;
    }
    
    this._attachGlobalPointer();
    this._isPressing = true;
    this._holdTimer = setTimeout(() => {
      this._isAdjusting = true;
      this._commitArmed = false;
      // Hold slider works for input_number and input_select
      this._showHoldSlider = !!this._config.show_hold_slider && (entityType === 'input_number' || entityType === 'input_select');
      this._render();
      if (this._inputEl) {
        try { this._inputEl.blur(); } catch (_) {}
        this._inputEl.readOnly = true;
        this._inputEl.classList.add('no-select');
      }
      window.addEventListener('keydown', this._onKeydown, true);
    }, 350);
  }

  _startTimeHold(e, component) {
    this._cancelHold();
    this._holdStartX = e.clientX;
    const { hours, minutes } = this._parseTimeValue(this._value);
    this._holdStartValue = component === 'hours' ? hours : minutes;
    this._timeComponent = component;
    this._attachGlobalPointer();
    this._isPressing = true;
    this._holdTimer = setTimeout(() => {
      this._isAdjusting = true;
      this._commitArmed = false;
      // Show hold slider for time components if enabled
      this._showHoldSlider = !!this._config.show_hold_slider;
      this._render();
      const targetInput = this.shadowRoot?.querySelector(`.${component}-input`);
      if (targetInput) {
        try { targetInput.blur(); } catch (_) {}
        targetInput.readOnly = true;
        targetInput.classList.add('no-select');
      }
      window.addEventListener('keydown', this._onKeydown, true);
    }, 350);
  }

  _moveHold(e) {
    if (!this._isAdjusting) return;
    if (e.cancelable) e.preventDefault();
    
    const entityType = this._getEntityType();
    
    if (entityType === 'input_number') {
      const container = this.shadowRoot.querySelector(this._isStandalone() ? 'ha-card' : 'div');
      const rect = (container ? container.getBoundingClientRect() : this.getBoundingClientRect());
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
    } else if (entityType === 'input_datetime' && this._timeComponent) {
      const container = this.shadowRoot.querySelector(this._isStandalone() ? 'ha-card' : 'div');
      const rect = (container ? container.getBoundingClientRect() : this.getBoundingClientRect());
      const width = rect?.width > 0 ? rect.width : 1;
      const deltaX = e.clientX - this._holdStartX;
      
      const { hours, minutes } = this._parseTimeValue(this._value);
      let newHours = hours;
      let newMinutes = minutes;
      
      if (this._timeComponent === 'hours') {
        const maxSteps = 23;
        const pixelsPerStep = width / maxSteps;
        const deltaSteps = Math.round(deltaX / pixelsPerStep);
        newHours = Math.max(0, Math.min(23, this._holdStartValue + deltaSteps));
      } else if (this._timeComponent === 'minutes') {
        const maxSteps = 59;
        const pixelsPerStep = width / maxSteps;
        const deltaSteps = Math.round(deltaX / pixelsPerStep);
        newMinutes = Math.max(0, Math.min(59, this._holdStartValue + deltaSteps));
      }
      
      const newTimeValue = this._formatTimeValue(newHours, newMinutes);
      if (newTimeValue !== this._value) {
        this._value = newTimeValue;
        this._renderValueOnly();
      }
    } else if (entityType === 'input_select') {
      const options = this._getSelectOptions();
      if (options.length === 0) return;
      
      const container = this.shadowRoot.querySelector(this._isStandalone() ? 'ha-card' : 'div');
      const rect = (container ? container.getBoundingClientRect() : this.getBoundingClientRect());
      const width = rect?.width > 0 ? rect.width : 1;
      const deltaX = e.clientX - this._holdStartX;
      
      // Calculate discrete steps - each option gets equal pixel space
      const totalSteps = Math.max(1, options.length - 1);
      const pixelsPerStep = width / totalSteps;
      const deltaSteps = Math.round(deltaX / pixelsPerStep);
      const newIndex = Math.max(0, Math.min(options.length - 1, this._holdStartValue + deltaSteps));
      const newValue = options[newIndex];
      
      // Only update overlay display, don't change actual value until release
      const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
      if (overlayVal && newValue) {
        overlayVal.textContent = newValue;
      }
      const overlaySlider = this.shadowRoot?.querySelector('.hold-slider-overlay input[type="range"]');
      if (overlaySlider) {
        overlaySlider.value = String(newIndex);
      }
    }
  }

  _endHold(e) {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      this._holdTimer = null;
    }
    if (this._isAdjusting) {
      this._commitArmed = true;
      // Always confirm adjust when releasing hold, regardless of show_hold_slider setting
      this._confirmAdjust(false);
      return;
    }
    this._detachGlobalPointer();
    if (this._inputEl && !this._isAdjusting) {
      const entityType = this._getEntityType();
      if (entityType === 'input_number') {
        this._inputEl.readOnly = false;
      } else if (entityType === 'input_datetime') {
        const hoursInput = this.shadowRoot?.querySelector('.hours-input');
        const minutesInput = this.shadowRoot?.querySelector('.minutes-input');
        if (hoursInput) hoursInput.readOnly = false;
        if (minutesInput) minutesInput.readOnly = false;
      }
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
      const entityType = this._getEntityType();
      if (entityType === 'input_number') {
        this._inputEl.classList.remove('no-select');
      } else if (entityType === 'input_datetime') {
        const hoursInput = this.shadowRoot?.querySelector('.hours-input');
        const minutesInput = this.shadowRoot?.querySelector('.minutes-input');
        if (hoursInput) hoursInput.classList.remove('no-select');
        if (minutesInput) minutesInput.classList.remove('no-select');
      }
    }
    this._isPressing = false;
  }

  _confirmAdjust(refocus = true) {
    if (!(this._isAdjusting && this._commitArmed)) return;
    this._awaitingServiceResult = true;
    
    // For select entities, get the final value from the overlay display
    const entityType = this._getEntityType();
    let finalValue = this._value;
    if (entityType === 'input_select') {
      const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
      if (overlayVal && overlayVal.textContent) {
        finalValue = overlayVal.textContent;
        // Update internal value so UI shows correct state
        this._value = finalValue;
      }
    }
    
    this._lastSentValue = finalValue;
    this._callSetValue(finalValue);
    this._isAdjusting = false;
    this._commitArmed = false;
    this._showHoldSlider = false;
    this._timeComponent = null;
    if (this._inputEl) {
      const entityType = this._getEntityType();
      if (entityType === 'input_number') {
        this._inputEl.readOnly = false;
        this._inputEl.classList.remove('no-select');
      } else if (entityType === 'input_datetime') {
        const hoursInput = this.shadowRoot?.querySelector('.hours-input');
        const minutesInput = this.shadowRoot?.querySelector('.minutes-input');
        if (hoursInput) {
          hoursInput.readOnly = false;
          hoursInput.classList.remove('no-select');
        }
        if (minutesInput) {
          minutesInput.readOnly = false;
          minutesInput.classList.remove('no-select');
        }
      }
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
      const entityType = this._getEntityType();
      if (entityType === 'input_number') {
        this._inputEl.readOnly = false;
        this._inputEl.classList.remove('no-select');
      } else if (entityType === 'input_datetime') {
        const hoursInput = this.shadowRoot?.querySelector('.hours-input');
        const minutesInput = this.shadowRoot?.querySelector('.minutes-input');
        if (hoursInput) {
          hoursInput.readOnly = false;
          hoursInput.classList.remove('no-select');
        }
        if (minutesInput) {
          minutesInput.readOnly = false;
          minutesInput.classList.remove('no-select');
        }
      }
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

  _scheduleRaf(callback) {
    const rafId = requestAnimationFrame(callback);
    this._rafIds.add(rafId);
    return rafId;
  }

  _cancelAllRafs() {
    for (const rafId of this._rafIds) {
      cancelAnimationFrame(rafId);
    }
    this._rafIds.clear();
  }

  _renderValueOnly() {
    const entityType = this._getEntityType();
    
    if (entityType === 'input_number') {
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
    } else if (entityType === 'input_datetime') {
      const { hours, minutes } = this._parseTimeValue(this._value);
      const hoursInput = this.shadowRoot?.querySelector('.hours-input');
      const minutesInput = this.shadowRoot?.querySelector('.minutes-input');
      if (hoursInput) {
        hoursInput.value = String(hours).padStart(2, '0');
        try { hoursInput.setAttribute('suffix', 'h'); } catch (_) {}
      }
      if (minutesInput) {
        minutesInput.value = String(minutes).padStart(2, '0');
        try { minutesInput.setAttribute('suffix', 'm'); } catch (_) {}
      }
      const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
      if (overlayVal) {
        overlayVal.textContent = this._formatTimeValue(hours, minutes);
      }
      // Update overlay slider if it exists
      const overlaySlider = this.shadowRoot?.querySelector('.hold-slider-overlay input[type="range"]');
      if (overlaySlider && this._timeComponent) {
        if (this._timeComponent === 'hours') {
          overlaySlider.value = String(hours);
        } else if (this._timeComponent === 'minutes') {
          overlaySlider.value = String(minutes);
        }
      }
    } else if (entityType === 'input_select') {
      const selectEl = this.shadowRoot?.querySelector('ha-select');
      if (selectEl) {
        selectEl.value = this._value || '';
      }
      // Update overlay slider if it exists
      const overlaySlider = this.shadowRoot?.querySelector('.hold-slider-overlay input[type="range"]');
      if (overlaySlider) {
        const options = this._getSelectOptions();
        const currentIndex = options.indexOf(this._value);
        overlaySlider.value = String(currentIndex >= 0 ? currentIndex : 0);
      }
      // Update overlay value display
      const overlayVal = this.shadowRoot?.querySelector('.overlay-value');
      if (overlayVal) {
        overlayVal.textContent = this._formatValueForDisplay();
      }
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
    const inputWidth = this._config?.width;
    const underlineThickness = this._config?.underline?.thickness;
    const underlineColor = this._config?.underline?.color;

    // Default to no ha-card wrapper (Home Assistant standard)
    const useHaCard = this._isStandalone();
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; }
      ${useHaCard ? 'ha-card { padding: 12px 16px; }' : ''}
      .row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 12px;
      }
      .icon { 
        color: var(--state-icon-color); 
        cursor: pointer; 
        margin-left: 8px;
      }
      .name {
        color: var(--primary-text-color);
        font-size: 14px;
        line-height: 1.2;
        overflow: hidden;
        margin-left: 8px;
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
      .value-container::after {
        ${underlineThickness && underlineThickness !== '0px' && underlineThickness !== '0' ? `content: ''; position: absolute; bottom: 0px; left: 0; right: 0; height: ${underlineThickness}; background: ${underlineColor}; border: none; box-shadow: none;` : ''}
      }
      ha-textfield {
        ${underlineThickness === '0px' || underlineThickness === '0' ? '--mdc-text-field-idle-line-color: transparent !important; --mdc-text-field-hover-line-color: transparent !important; --mdc-text-field-focus-line-color: transparent !important; --mdc-notched-outline-border-color: transparent !important; --mdc-text-field-outlined-idle-border-color: transparent !important; --mdc-text-field-outlined-hover-border-color: transparent !important; --mdc-text-field-outlined-focused-border-color: transparent !important;' : ''}
      }
      ha-select {
        ${underlineThickness === '0px' || underlineThickness === '0' ? '--mdc-select-idle-line-color: transparent !important; --mdc-select-hover-line-color: transparent !important; --mdc-select-focused-line-color: transparent !important; --mdc-notched-outline-border-color: transparent !important; --mdc-select-outlined-idle-border-color: transparent !important; --mdc-select-outlined-hover-border-color: transparent !important; --mdc-select-outlined-focused-border-color: transparent !important;' : ''}
      }
      ha-textfield {
        ${inputBg ? `--mdc-text-field-fill-color: ${inputBg};` : ''}
        ${inputWidth ? `width: ${inputWidth};` : ''}
        ${height ? `--mdc-text-field-fill-height: ${height}; height: ${height};` : ''}
      }
      ha-select {
        ${inputBg ? `--mdc-select-fill-color: ${inputBg}; --mdc-theme-surface: ${inputBg};` : ''}
        ${inputWidth ? `width: ${inputWidth};` : ''}
        ${height ? `--ha-select-height: ${height};` : ''}
        min-width: 120px;
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
      .time-container {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .time-separator {
        color: var(--primary-text-color);
        font-size: 18px;
        font-weight: bold;
        margin: 0 4px;
      }
      .hours-input, .minutes-input {
        text-align: center;
        flex-shrink: 0;
      }
      .hours-input .mdc-text-field__affix--suffix,
      .minutes-input .mdc-text-field__affix--suffix {
        padding-left: 2px !important;
        padding-right: 3px !important;
        min-width: 8px !important;
      }
    `;

    const container = useHaCard ? document.createElement('ha-card') : document.createElement('div');
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

    // Input field - different for each entity type
    const entityType = this._getEntityType();
    let inputContainer;
    
    if (entityType === 'input_number') {
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
      if (inputWidth) {
        tf.style.width = inputWidth;
      }
      tf.addEventListener('change', () => this._onInputCommit({ currentTarget: { value: tf.value } }));
      tf.addEventListener('pointerdown', (ev) => this._startHold(ev));
      this._inputEl = tf;
      inputContainer = tf;
    } else if (entityType === 'input_datetime') {
      const timeContainer = document.createElement('div');
      timeContainer.className = 'time-container';
      
      const { hours, minutes } = this._parseTimeValue(this._value);
      
      const hoursInput = document.createElement('ha-textfield');
      hoursInput.className = 'hours-input';
      hoursInput.type = 'text';
      hoursInput.setAttribute('inputmode', 'numeric');
      hoursInput.value = String(hours).padStart(2, '0');
      hoursInput.setAttribute('suffix', 'h');
      if (inputWidth) {
        const numericWidth = parseInt(inputWidth);
        hoursInput.style.width = `${Math.floor(numericWidth / 2) - 10}px`;
      } else {
        hoursInput.style.width = '75px';
      }
      if (height) {
        hoursInput.style.setProperty('--mdc-text-field-fill-height', height);
        hoursInput.style.height = height;
      }
      
      const separator = document.createElement('span');
      separator.textContent = ':';
      separator.className = 'time-separator';
      
      const minutesInput = document.createElement('ha-textfield');
      minutesInput.className = 'minutes-input';
      minutesInput.type = 'text';
      minutesInput.setAttribute('inputmode', 'numeric');
      minutesInput.value = String(minutes).padStart(2, '0');
      minutesInput.setAttribute('suffix', 'm');
      if (inputWidth) {
        const numericWidth = parseInt(inputWidth);
        minutesInput.style.width = `${Math.floor(numericWidth / 2) - 10}px`;
      } else {
        minutesInput.style.width = '75px';
      }
      if (height) {
        minutesInput.style.setProperty('--mdc-text-field-fill-height', height);
        minutesInput.style.height = height;
      }
      
      const commitTime = () => {
        const h = Math.max(0, Math.min(23, parseInt(hoursInput.value) || 0));
        const m = Math.max(0, Math.min(59, parseInt(minutesInput.value) || 0));
        // Update display with validated values
        hoursInput.value = String(h).padStart(2, '0');
        minutesInput.value = String(m).padStart(2, '0');
        this._onInputCommit({ currentTarget: { value: this._formatTimeValue(h, m) } });
      };
      
      hoursInput.addEventListener('change', commitTime);
      minutesInput.addEventListener('change', commitTime);
      hoursInput.addEventListener('pointerdown', (ev) => this._startTimeHold(ev, 'hours'));
      minutesInput.addEventListener('pointerdown', (ev) => this._startTimeHold(ev, 'minutes'));
      
      timeContainer.appendChild(hoursInput);
      timeContainer.appendChild(separator);
      timeContainer.appendChild(minutesInput);
      
      this._inputEl = timeContainer;
      inputContainer = timeContainer;
    } else if (entityType === 'input_select') {
      const selectEl = document.createElement('ha-select');
      selectEl.value = this._value || '';
      
      const options = this._getSelectOptions();
      options.forEach(option => {
        const item = document.createElement('mwc-list-item');
        item.value = option;
        item.textContent = option;
        selectEl.appendChild(item);
      });
      
      selectEl.addEventListener('selected', (ev) => {
        const selectedValue = ev.target.value;
        this._onInputCommit({ currentTarget: { value: selectedValue } });
      });
      selectEl.addEventListener('pointerdown', (ev) => this._startHold(ev));
      
      this._inputEl = selectEl;
      inputContainer = selectEl;
    }

    right.appendChild(inputContainer);

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
          this._scheduleRaf(() => {
            try { this._inputEl.focus({ preventScroll: true }); } catch (_) { this._inputEl.focus(); }
          });
        }
        this._refocusAfterCommit = true;
      } else if (this._inputEl) {
        this._scheduleRaf(() => {
          try { this._inputEl.focus({ preventScroll: true }); } catch (_) { this._inputEl.focus(); }
        });
      }
    };
    right.addEventListener('click', confirmHandler, { capture: true });
    inputContainer.addEventListener('click', confirmHandler, { capture: true });

    // Hold slider overlay
    if (this._showHoldSlider) {
      const overlay = document.createElement('div');
      overlay.className = 'hold-slider-overlay';
      
      if (entityType === 'input_number') {
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
      } else if (entityType === 'input_datetime' && this._timeComponent) {
        // Show slider for the specific time component being adjusted
        const slider = document.createElement('input');
        slider.type = 'range';
        if (this._timeComponent === 'hours') {
          slider.min = '0';
          slider.max = '23';
          slider.step = '1';
          const { hours } = this._parseTimeValue(this._value);
          slider.value = String(hours);
        } else {
          slider.min = '0';
          slider.max = '59';
          slider.step = '1';
          const { minutes } = this._parseTimeValue(this._value);
          slider.value = String(minutes);
        }
        slider.addEventListener('input', (e) => this._onTimeSliderInput(e));
        overlay.appendChild(slider);
        const overlayValue = document.createElement('span');
        overlayValue.className = 'overlay-value';
        overlayValue.textContent = this._formatValueForDisplay();
        overlay.appendChild(overlayValue);
      } else if (entityType === 'input_select') {
        const options = this._getSelectOptions();
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(Math.max(0, options.length - 1));
        slider.step = '1';
        const currentIndex = options.indexOf(this._value);
        slider.value = String(currentIndex >= 0 ? currentIndex : 0);
        slider.addEventListener('input', (e) => this._onSelectSliderInput(e));
        overlay.appendChild(slider);
        const overlayValue = document.createElement('span');
        overlayValue.className = 'overlay-value';
        overlayValue.textContent = this._formatValueForDisplay();
        overlay.appendChild(overlayValue);
      }
      
      container.appendChild(overlay);
    }

    row.appendChild(iconWrap);
    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);

    // Entity not found help
    if (!entity) {
      const help = document.createElement('div');
      help.className = 'help';
      help.textContent = 'Entity not found. Check entity id in card config.';
      container.appendChild(help);
    }

    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(style);
    this.shadowRoot.appendChild(container);
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
  description: 'input_number, number, input_datetime, input_select, and select card with hold-to-slide adjustment',
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
        width: undefined,
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
      } else if (key === 'height' || key === 'input_background' || key === 'width' || key === 'name') {
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
      picker.includeDomains = ['input_number', 'number', 'input_datetime', 'input_select', 'select'];
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

      // Width
      const width = document.createElement('ha-textfield');
      width.label = 'Width (e.g. 120px)';
      width.value = this._config.width || '';
      width.dataset.key = 'width';
      width.addEventListener('change', (e) => this._onTextChange(e));
      root.appendChild(mkRow('Width', width));

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