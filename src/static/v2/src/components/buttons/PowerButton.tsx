import React from "react";
import { motion } from "framer-motion";
import { Power, Radio } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";

interface PowerButtonProps {
  powerOn: boolean;
  liveMode: boolean;
  onPowerToggle: () => void;
  onLiveModeToggle: () => void;
}

export const PowerButton: React.FC<PowerButtonProps> = ({
  powerOn,
  liveMode,
  onPowerToggle,
  onLiveModeToggle,
}) => {
  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20">
      <div className="flex items-center gap-2">
        <Tooltip
          text={powerOn ? "Turn Off All LEDs" : "Turn On All LEDs"}
          position="bottom"
        >
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onPowerToggle}
            className={`px-6 py-3 rounded-full backdrop-blur-xl transition-all ${
              powerOn
                ? "bg-green-500/20 border border-green-500/50 text-green-400"
                : "bg-white/10 border border-white/20 text-gray-400"
            }`}
          >
            <div className="flex items-center gap-2">
              <Power size={20} />
              <span className="font-medium">{powerOn ? "ON" : "OFF"}</span>
            </div>
          </motion.button>
        </Tooltip>

        <Tooltip
          text={
            liveMode
              ? "Live Mode: Changes sync with hardware"
              : "Live Mode Off: Hardware plays independently"
          }
          position="bottom"
        >
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onLiveModeToggle}
            className={`px-6 py-3 rounded-full backdrop-blur-xl transition-all ${
              liveMode
                ? "bg-blue-500/20 border border-blue-500/50 text-blue-400"
                : "bg-white/10 border border-white/20 text-gray-400"
            }`}
          >
            <div className="flex items-center gap-2">
              <Radio size={20} />
              <span className="font-medium">{liveMode ? "LIVE" : "OFF"}</span>
            </div>
          </motion.button>
        </Tooltip>
      </div>
    </div>
  );
};

