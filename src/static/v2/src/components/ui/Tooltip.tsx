import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { TooltipPosition } from "../../types/editor";

interface TooltipProps {
  children: React.ReactNode;
  text: string;
  position?: TooltipPosition;
  offsetClassName?: string;
  offsetPx?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
  children,
  text,
  position = "top",
  offsetClassName = "",
  offsetPx,
}) => {
  const [show, setShow] = useState(false);

  const getPositionClasses = () => {
    switch (position) {
      case "right":
        return "left-full top-1/2 -translate-y-1/2 ml-2";
      case "bottom-left":
        return "top-full right-0 mt-2";
      case "bottom":
        return "top-full left-1/2 -translate-x-1/2 mt-2";
      case "top":
      default:
        return "bottom-full left-1/2 -translate-x-1/2 mb-2";
    }
  };

  const getArrowClasses = () => {
    switch (position) {
      case "right":
        return "right-full top-1/2 -translate-y-1/2 mr-px border-r-4 border-r-black/90 border-t-4 border-t-transparent border-b-4 border-b-transparent border-l-0";
      case "bottom-left":
        return "bottom-full right-2 mb-px border-b-4 border-b-black/90 border-l-4 border-l-transparent border-r-4 border-r-transparent border-t-0";
      case "bottom":
        return "top-0 left-1/2 -translate-x-1/2 -mt-px border-t-4 border-t-black/90 border-l-4 border-l-transparent border-r-4 border-r-transparent border-b-0";
      case "top":
      default:
        return "top-full left-1/2 -translate-x-1/2 -mt-px border-t-4 border-t-black/90 border-l-4 border-l-transparent border-r-4 border-r-transparent border-b-0";
    }
  };

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      <AnimatePresence>
        {show ? (
          <motion.div
            initial={{
              opacity: 0,
              y: position === "right" ? 0 : 5,
              x: position === "right" ? 5 : 0,
            }}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={{
              opacity: 0,
              y: position === "right" ? 0 : 5,
              x: position === "right" ? 5 : 0,
            }}
            className={`absolute ${getPositionClasses()} ${offsetClassName} px-3 py-1.5 bg-black/90 backdrop-blur-sm text-white text-xs rounded-lg whitespace-nowrap pointer-events-none z-50 border border-white/10`}
            style={offsetPx ? { marginLeft: offsetPx } : undefined}
          >
            {text}
            <div className={`absolute ${getArrowClasses()} w-0 h-0`} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

