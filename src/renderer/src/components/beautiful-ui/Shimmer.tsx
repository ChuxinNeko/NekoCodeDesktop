export function Shimmer({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-block bg-clip-text text-transparent ${className}`}
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--bui-ink-3) 35%, var(--bui-ink) 50%, var(--bui-ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "bui-shimmer-text 1.8s linear infinite",
      }}
    >
      {children}
    </span>
  );
}
