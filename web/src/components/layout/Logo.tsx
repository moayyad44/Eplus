export function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'h-12 w-12 rounded-2xl' : 'h-9 w-9 rounded-xl';
  return (
    <div className="flex items-center gap-2.5" dir="ltr">
      <span className={`grid ${box} place-items-center bg-gradient-to-br from-primary-300 to-primary-500 shadow-sm`}>
        <svg viewBox="0 0 24 24" className={size === 'lg' ? 'h-7 w-7' : 'h-5 w-5'} fill="white" aria-hidden>
          <path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className={`block font-extrabold tracking-tight text-ink ${size === 'lg' ? 'text-2xl' : 'text-[15px]'}`}>
          Emergency<span className="text-primary-500">Plus</span>
        </span>
        {size === 'lg' && <span className="block text-xs font-medium text-ink-muted">Clinic Management System</span>}
      </span>
    </div>
  );
}
