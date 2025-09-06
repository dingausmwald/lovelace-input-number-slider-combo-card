# Lovelace Input Number Slider Combo Card

Custom Lovelace card for Home Assistant with **Long Press Slider** functionality for `input_number` entities.

![Configuration](konfig.JPG)
![Slider](slider.JPG)

## Features
- **Long Press Slider**: Hold the input field and slide left/right to adjust values
- Optional visual slider overlay during adjustment
- Respects entity `min`, `max`, `step` and `unit_of_measurement`
- Configurable styling (height, background, underline)
- Hide number input spinners option

## Installation

### HACS (Recommended)
1. Add this repository to HACS as custom repository
2. Install "Input Number Slider Combo Card"
3. Restart Home Assistant

### Manual
1. Copy `input-number-slider-combo-card.js` to `/config/www/`
2. Add resource in Settings → Dashboards → Resources:
```yaml
resources:
  - url: /local/input-number-slider-combo-card.js
    type: module
```

## Configuration

```yaml
type: custom:input-number-slider-combo-card
entity: input_number.target_temperature
name: Temperature                    # optional override
height: 30px                        # optional CSS height
input_background: rgba(0,0,0,.04)   # optional input background
underline:
  thickness: 2px                    # optional underline
  color: var(--primary-color)
show_hold_slider: true              # show slider overlay while holding
hide_spinners: false                # hide number input spinners
```

## Usage
- **Long Press**: Hold input field for 350ms, then slide left/right to adjust
- **Regular Input**: Click to type value normally
- **ESC**: Cancel adjustment during hold-slide

---

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/dingausmwald)


