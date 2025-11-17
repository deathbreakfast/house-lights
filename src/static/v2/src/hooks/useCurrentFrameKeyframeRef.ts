/** Hook for managing the current frame keyframe reference. */

import { useEffect, useRef } from "react";

type CurrentFrameKeyframeRef = {
  timestamp: number;
  keyframeId: string;
} | null;

export const useCurrentFrameKeyframeRef = (
  timelinePosition: number
): React.MutableRefObject<CurrentFrameKeyframeRef> => {
  const currentFrameKeyframeRef = useRef<CurrentFrameKeyframeRef>(null);

  useEffect(() => {
    currentFrameKeyframeRef.current = null;
  }, [timelinePosition]);

  return currentFrameKeyframeRef;
};

