import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-primary-600 text-white hover:bg-primary-700 shadow-sm disabled:bg-primary-300',
  secondary: 'bg-primary-50 text-primary-800 hover:bg-primary-100 border border-primary-100',
  outline: 'bg-white text-ink border border-line-strong hover:bg-surface-subtle',
  ghost: 'text-ink-soft hover:bg-surface-sunken hover:text-ink',
  danger: 'bg-danger-600 text-white hover:bg-danger-700 shadow-sm',
  success: 'bg-success-600 text-white hover:bg-success-700 shadow-sm',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-base gap-2 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: Variant; size?: 'sm' | 'md' }>(
  function IconButton({ label, variant = 'ghost', size = 'md', className, children, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        title={label}
        aria-label={label}
        className={clsx(
          'inline-flex items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 disabled:opacity-40 disabled:cursor-not-allowed',
          size === 'sm' ? 'h-7 w-7' : 'h-9 w-9',
          variants[variant],
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
