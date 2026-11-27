// Dakort's mark, drawn inline so it scales crisp at any size.

// Mark is Dakort's icon (public/favicon.svg): the ink d on the lime tile.
export function Mark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#c7f24f" />
      <path fill="#14170e" fillRule="evenodd" d="M40 13L48 8V56H40V53.86A16 16 0 1 1 40 26.14ZM32 32a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z" />
    </svg>
  )
}
