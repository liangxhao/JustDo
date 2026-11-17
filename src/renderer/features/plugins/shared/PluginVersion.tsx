const PluginVersion = ({ version }: { version?: string }) => {
  if (!version?.trim()) return null;

  return (
    <span
      className="max-w-[45%] shrink-0 truncate rounded-md bg-[color:color-mix(in_srgb,var(--justdo-foreground)_7%,transparent)] px-1.5 text-[11px] font-medium leading-5 text-secondary"
      title={version}
    >
      {version}
    </span>
  );
};

export default PluginVersion;
