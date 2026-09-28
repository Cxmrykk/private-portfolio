import './dive.js'; // Imports and natively executes the Dive scroll listeners
import { initOcean } from './ocean.js';
import { initSparkline } from './sparkline.js';
import { initSettingsToggle } from './settings-toggle.js';

// Initialize remaining modules
initSettingsToggle();
initOcean();
initSparkline();
