import type { ButtonHTMLAttributes, ReactNode } from 'react'

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
  variant?: 'ghost' | 'soft' | 'primary' | 'danger'
}

export function IconButton({ label, children, variant = 'ghost', className = '', ...props }: IconButtonProps) {
  return (
    <button
      aria-label={label}
      className={`icon-button icon-button--${variant} ${className}`}
      title={label}
      type="button"
      {...props}
    >
      {children}
    </button>
  )
}
