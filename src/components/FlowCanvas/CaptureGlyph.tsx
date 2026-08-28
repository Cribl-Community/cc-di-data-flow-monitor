import { forwardRef } from 'react';
import type { SvgIcon } from '@capra/icons';

// A camera-aperture-style ring+dot glyph for the Live Capture affordance, per a reference image
// the user supplied — bolder and more literal than @capra/icons' `CameraOutlined` camera-body
// silhouette. Matches the app's own hand-drawn icon convention (see ThemeIcons.tsx): 20x20
// viewBox, currentColor. Built to satisfy Capra's own `SvgIcon` shape (a forwardRef component
// carrying `displayName`/`__brand`) since `IconButton.icon` only accepts that exact type — the
// factory that normally stamps this is internal to @capra/icons, not part of its public API, so
// this constructs the same shape directly from the type it does export.
const CaptureGlyphBase = forwardRef<SVGSVGElement, React.SVGProps<SVGSVGElement>>(function CaptureGlyphBase(props, ref) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 20 20" fill="none" ref={ref} aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="7.75" stroke="currentColor" strokeWidth="2.75" />
      <circle cx="10" cy="10" r="3.75" fill="currentColor" />
    </svg>
  );
});

export const CaptureGlyph = Object.assign(CaptureGlyphBase, { displayName: 'CaptureGlyph', __brand: 'icon' as const }) as SvgIcon;
