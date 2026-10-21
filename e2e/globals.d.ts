// What the UI tests read off the running app. `window.klndr` is the app
// instance (protected/js/app.js); only the parts the tests touch are typed.
type E2ESegment = { id: string; start_time: number; duration: number; completed: boolean };

interface Window {
  klndr?: {
    tasks: Array<{ id: string; title: string; segments?: E2ESegment[] }>;
    canvasRenderer?: unknown;
    dragController?: { activeDrag: unknown };
  };
}
