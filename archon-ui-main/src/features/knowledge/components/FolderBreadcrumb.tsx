/**
 * FolderBreadcrumb Component
 * Displays the current folder path for navigation
 */

import { ChevronRight, Home } from "lucide-react";
import { cn } from "@/features/ui/primitives/styles";

interface FolderBreadcrumbProps {
  path: string[];
  onNavigate?: (index: number) => void;
  className?: string;
}

export const FolderBreadcrumb: React.FC<FolderBreadcrumbProps> = ({
  path,
  onNavigate,
  className,
}) => {
  if (!path || path.length === 0) {
    return (
      <div className={cn("flex items-center gap-2 text-sm", className)}>
        <button
          type="button"
          onClick={() => onNavigate?.(0)}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md",
            "text-gray-700 dark:text-gray-300",
            "hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10",
            "transition-colors",
          )}
          aria-label="Navigate to root"
        >
          <Home className="w-4 h-4" />
          <span className="font-medium">All Sources</span>
        </button>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-1 text-sm overflow-x-auto", className)}>
      {/* Home / Root */}
      <button
        type="button"
        onClick={() => onNavigate?.(-1)}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 rounded-md shrink-0",
          "text-gray-600 dark:text-gray-400",
          "hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10 hover:text-gray-900 dark:hover:text-gray-200",
          "transition-colors",
        )}
        aria-label="Navigate to root"
      >
        <Home className="w-4 h-4" />
      </button>

      {/* Path segments */}
      {path.map((segment, index) => {
        const isLast = index === path.length - 1;

        return (
          <div key={index} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-600" />

            {isLast ? (
              <span className="px-2 py-1 font-semibold text-cyan-700 dark:text-cyan-300">
                {segment}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate?.(index)}
                className={cn(
                  "px-2 py-1 rounded-md",
                  "text-gray-600 dark:text-gray-400",
                  "hover:bg-cyan-500/10 dark:hover:bg-cyan-400/10 hover:text-gray-900 dark:hover:text-gray-200",
                  "transition-colors",
                )}
              >
                {segment}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

