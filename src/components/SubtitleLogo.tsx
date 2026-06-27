type SubtitleLogoProps = {
  className?: string
  size?: number
}

export function SubtitleLogo({ className, size = 24 }: SubtitleLogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 32 32"
      width={size}
    >
      <path
        d="M6 5.5h20a3.5 3.5 0 0 1 3.5 3.5v11A3.5 3.5 0 0 1 26 23.5H15l-6.5 4v-4H6A3.5 3.5 0 0 1 2.5 20V9A3.5 3.5 0 0 1 6 5.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="2.25"
      />
      <path d="M8 12h16M10.5 17h11" stroke="currentColor" strokeLinecap="round" strokeWidth="2.25" />
    </svg>
  )
}
