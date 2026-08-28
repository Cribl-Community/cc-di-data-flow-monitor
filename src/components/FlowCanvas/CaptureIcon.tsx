import { IconButton, Tooltip } from '@capra/core';
import type { CaptureLevel } from '../../lib/types';
import { CAPTURE_LEVEL_LABEL } from '../../lib/types';
import { CaptureGlyph } from './CaptureGlyph';
import './CaptureIcon.css';

export function CaptureIcon({
  x,
  y,
  level,
  onClick,
}: {
  x: number;
  y: number;
  level: CaptureLevel;
  onClick: (level: CaptureLevel) => void;
}) {
  return (
    <div className="capture-icon" style={{ left: x, top: y }}>
      <Tooltip title={`Capture — ${CAPTURE_LEVEL_LABEL[level]}`} placement="top">
        <IconButton
          icon={CaptureGlyph}
          aria-label={`Capture ${CAPTURE_LEVEL_LABEL[level]}`}
          size="md"
          variant="secondary"
          FORCE__className="capture-icon-button"
          onClick={(e) => {
            e.stopPropagation();
            onClick(level);
          }}
        />
      </Tooltip>
    </div>
  );
}
