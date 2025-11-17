/** Lightweight notification system for user feedback. */

export type NotificationType = "error" | "warning" | "info" | "success";

export interface Notification {
  id: string;
  message: string;
  type: NotificationType;
  timestamp: number;
}

type NotificationListener = (notification: Notification) => void;

class NotificationManager {
  private listeners: Set<NotificationListener> = new Set();
  private notifications: Notification[] = [];
  private maxNotifications = 5;
  private autoDismissDelay = 5000; // 5 seconds

  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(notification: Notification): void {
    this.notifications.push(notification);
    if (this.notifications.length > this.maxNotifications) {
      this.notifications.shift();
    }
    this.listeners.forEach((listener) => listener(notification));
    
    // Auto-dismiss after delay (except errors which persist)
    if (notification.type !== "error") {
      setTimeout(() => {
        this.dismiss(notification.id);
      }, this.autoDismissDelay);
    }
  }

  dismiss(id: string): void {
    this.notifications = this.notifications.filter((n) => n.id !== id);
  }

  clear(): void {
    this.notifications = [];
  }

  getNotifications(): Notification[] {
    return [...this.notifications];
  }

  error(message: string): void {
    const notification: Notification = {
      id: `error-${Date.now()}-${Math.random()}`,
      message,
      type: "error",
      timestamp: Date.now(),
    };
    this.notify(notification);
    // Also log to console for debugging
    console.error(`[Notification] ${message}`);
  }

  warning(message: string): void {
    const notification: Notification = {
      id: `warning-${Date.now()}-${Math.random()}`,
      message,
      type: "warning",
      timestamp: Date.now(),
    };
    this.notify(notification);
  }

  info(message: string): void {
    const notification: Notification = {
      id: `info-${Date.now()}-${Math.random()}`,
      message,
      type: "info",
      timestamp: Date.now(),
    };
    this.notify(notification);
  }

  success(message: string): void {
    const notification: Notification = {
      id: `success-${Date.now()}-${Math.random()}`,
      message,
      type: "success",
      timestamp: Date.now(),
    };
    this.notify(notification);
  }

  // Convenience method to show error from API failures
  apiError(context: string, error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "An unexpected error occurred";
    this.error(`${context}: ${message}`);
  }
}

export const notificationManager = new NotificationManager();

// React hook for using notifications
import { useEffect, useState } from "react";

export const useNotifications = () => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    const unsubscribe = notificationManager.subscribe((notification) => {
      setNotifications(notificationManager.getNotifications());
    });
    setNotifications(notificationManager.getNotifications());
    return unsubscribe;
  }, []);

  return {
    notifications,
    error: (message: string) => notificationManager.error(message),
    warning: (message: string) => notificationManager.warning(message),
    info: (message: string) => notificationManager.info(message),
    success: (message: string) => notificationManager.success(message),
    apiError: (context: string, error: unknown) =>
      notificationManager.apiError(context, error),
    dismiss: (id: string) => notificationManager.dismiss(id),
    clear: () => notificationManager.clear(),
  };
};

