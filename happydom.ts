// Registers a happy-dom global environment for `bun test`, so the hook-level
// tests in src/query.hooks.test.ts can render React with @testing-library/react.
// Wired in via bunfig.toml ([test] preload). Not shipped (devDependency only).
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();
