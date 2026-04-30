import { BaseEdge, EdgeProps, getBezierPath } from '@xyflow/react';

export function AnimatedEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style = {},
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const isAnimated = !!data?.isAnimated;
  const isFaded   = !!data?.isFaded;

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: isAnimated ? 2.5 : 1.5,
          stroke: isAnimated ? '#06b6d4' : '#475569',
          opacity: isFaded ? 0.15 : 1,
          transition: 'stroke 0.4s, opacity 0.4s',
        }}
      />
      {isAnimated && (
        <>
          {/* Primary moving dot */}
          <circle r="5" fill="#22d3ee" filter="url(#glow)">
            <animateMotion dur="1.6s" repeatCount="indefinite" path={edgePath} />
          </circle>
          {/* Trailing dot */}
          <circle r="3" fill="#67e8f9" opacity="0.6">
            <animateMotion dur="1.6s" begin="0.3s" repeatCount="indefinite" path={edgePath} />
          </circle>
          {/* SVG glow filter (defined once, safe to repeat in SVG defs) */}
          <defs>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        </>
      )}
    </>
  );
}
