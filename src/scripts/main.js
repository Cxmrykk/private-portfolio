import './dive.js'; // Imports and natively executes the Dive scroll listeners
import { initOcean } from './ocean.js';
import { initSparkline } from './sparkline.js';
import { initProjects } from './projects.js';

// Initialize remaining modules
initProjects();
initOcean();
initSparkline();
