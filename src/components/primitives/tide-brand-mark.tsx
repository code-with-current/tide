/** TideBrandMark: the Tide wave logo on a brand-orange rounded tile. Sizes: sm/md/lg/xl. Shared across dialog headers, onboarding, and About. */
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
