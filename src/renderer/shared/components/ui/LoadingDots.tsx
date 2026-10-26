export default function LoadingDots() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
      {[0, 150, 300].map(delay => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-current animate-bounce motion-reduce:animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}
