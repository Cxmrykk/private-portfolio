import './dive.js'; // Imports and natively executes the Dive scroll listeners
import { initOcean } from './ocean.js';
import { initSparkline } from './sparkline.js';
import { initSettingsToggle } from './settings-toggle.js';
import { initDates } from './dates.js';
import { createScroller } from './scroll/scroller.js';
import { bindScrollInputs } from './scroll/inputs.js';
import { bindAnchorLinks } from './scroll/anchors.js';

// Fill in the years first, so the layout the scroller measures is final
initDates();

// Section scrolling: one engine, fed by wheel / touch / keys and by in-page links
const scroller = createScroller();
bindScrollInputs(scroller);
bindAnchorLinks(scroller);

// Initialize remaining modules
initSettingsToggle();
initOcean();
initSparkline();
