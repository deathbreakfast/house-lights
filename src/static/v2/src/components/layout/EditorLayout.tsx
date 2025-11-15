import React, { RefObject, ReactNode } from "react";

interface EditorLayoutProps {
  fileInputRef: RefObject<HTMLInputElement>;
  audioInputRef: RefObject<HTMLInputElement>;
  children: ReactNode;
}

export const EditorLayout: React.FC<EditorLayoutProps> = ({
  fileInputRef,
  audioInputRef,
  children,
}) => {
  return (
    <div className="h-screen w-screen flex flex-col bg-[#0f0f0f] overflow-hidden">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
      />
      {children}
    </div>
  );
};

