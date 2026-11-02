/** Skeleton shown while a server-rendered screen loads, so taps feel instant. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton mb-2.5 h-3.5 w-36" />
      <div className="skeleton mb-7 h-8 w-44 rounded-lg" />
      <div className="space-y-3">
        <div className="card h-44 p-5">
          <div className="skeleton h-3 w-24" />
          <div className="skeleton mt-3 h-6 w-40" />
          <div className="mt-8 grid grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-8" />
            ))}
          </div>
        </div>
        <div className="card h-56" />
        <div className="card h-32" />
      </div>
    </div>
  );
}
