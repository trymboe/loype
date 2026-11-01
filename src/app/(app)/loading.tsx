/** Skeleton shown while a server-rendered screen loads, so taps feel instant. */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-3 w-32 rounded bg-surface-2" />
      <div className="mb-6 h-9 w-40 rounded-lg bg-surface-2" />
      <div className="space-y-4">
        <div className="card h-40" />
        <div className="card h-56" />
        <div className="card h-32" />
      </div>
    </div>
  );
}
