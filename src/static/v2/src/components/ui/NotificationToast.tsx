/** Toast notification component for displaying user feedback. */

import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Notification } from "../../utils/notifications";

interface NotificationToastProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

export const NotificationToast: React.FC<NotificationToastProps> = ({
  notification,
  onDismiss,
}) => {
  useEffect(() => {
    // Auto-dismiss errors after 8 seconds, others after 5 seconds
    const delay = notification.type === "error" ? 8000 : 5000;
    const timer = setTimeout(() => {
      onDismiss(notification.id);
    }, delay);
    return () => clearTimeout(timer);
  }, [notification.id, notification.type, onDismiss]);

  const getStyles = () => {
    switch (notification.type) {
      case "error":
        return "bg-red-500/20 border-red-500/50 text-red-200";
      case "warning":
        return "bg-yellow-500/20 border-yellow-500/50 text-yellow-200";
      case "success":
        return "bg-green-500/20 border-green-500/50 text-green-200";
      case "info":
      default:
        return "bg-blue-500/20 border-blue-500/50 text-blue-200";
    }
  };

  const getIcon = () => {
    switch (notification.type) {
      case "error":
        return "✕";
      case "warning":
        return "⚠";
      case "success":
        return "✓";
      case "info":
      default:
        return "ℹ";
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
      className={`rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm ${getStyles()}`}
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none">{getIcon()}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium break-words">
            {notification.message}
          </p>
        </div>
        <button
          onClick={() => onDismiss(notification.id)}
          className="text-current/60 hover:text-current transition-colors ml-2 flex-shrink-0"
          aria-label="Dismiss notification"
        >
          ✕
        </button>
      </div>
    </motion.div>
  );
};

interface NotificationContainerProps {
  notifications: Notification[];
  onDismiss: (id: string) => void;
}

export const NotificationContainer: React.FC<NotificationContainerProps> = ({
  notifications,
  onDismiss,
}) => {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      <AnimatePresence mode="popLayout">
        {notifications.map((notification) => (
          <div key={notification.id} className="pointer-events-auto">
            <NotificationToast
              notification={notification}
              onDismiss={onDismiss}
            />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
};

