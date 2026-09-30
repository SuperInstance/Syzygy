// index.mjs — import this once to load every plugin into the registry.
export * from './registry.mjs';
import './projectors/mirror.mjs';
import './projectors/syzygy.mjs';
import './projectors/motion.mjs';
import './scorers/inverse.mjs';
import './scorers/vlm.mjs';
import './scorers/jepa.mjs';
