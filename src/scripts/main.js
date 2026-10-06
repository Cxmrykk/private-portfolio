import './dive.js'; // Imports and natively executes the Dive scroll listeners
import { initOcean } from './ocean.js';
import { initSparkline } from './sparkline.js';
import { initSettingsToggle } from './settings-toggle.js';
import { initClockLabel } from './clock-label.js';
import { initDates } from './dates.js';
import { createScroller } from './scroll/scroller.js';
import { bindScrollInputs } from './scroll/inputs.js';
import { bindAnchorLinks } from './scroll/anchors.js';

// Fill in the years first, so the layout the scroller measures is final
initDates();

// The Settings pill shows Sydney's time; set it before layout is measured
// too, since its text (and so its width) changes
initClockLabel();

// Section scrolling: one engine, fed by wheel / touch / keys and by in-page links
const scroller = createScroller();
bindScrollInputs(scroller);
bindAnchorLinks(scroller);

// Initialize remaining modules
initSettingsToggle();
initOcean();
initSparkline();
