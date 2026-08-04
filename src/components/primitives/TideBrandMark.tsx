/**
 * TideBrandMark — the Tide wave logo on the brand-orange (#d97757) tile.
 *
 * The shared brand-mark treatment used across the app: the Add Workspace /
 * MCP dialog headers, the onboarding screens, and now the About screen.
 * One visual language instead of raw floating logo images.
 *
 * `size`:
 *   sm = mobile/compact headers (size-7 tile)
 *   md = section headers (size-8 tile)
 *   lg = hero/About (size-12 tile)
 *
 * The wave logo is rendered on a faint orange-tinted rounded tile with a
 * subtle border, matching StyleAvatar / the dialog header tiles.
 */
import tideLogoSvg from '@/assets/logo.svg';

export function TideBrandMark({
  size = 'md',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const tile =
    size === 'sm' ? 'size-7' : size === 'lg' ? 'size-12' : size === 'xl' ? 'size-16' : 'size-8';
  const mark =
    size === 'sm' ? 'size-4' : size === 'lg' ? 'size-7' : size === 'xl' ? 'size-8' : 'size-5';
  return (
    <span
      className={`${tile} rounded-[10px] flex items-center justify-center shrink-0 border ${className}`}
      style={{ background: 'rgba(21,21,21,0.9)', borderColor: 'rgba(85,85,85,0.2)' }}
    >
      <img src={tideLogoSvg} alt="" className={`${mark} object-contain`} />
    </span>
  );
}
