import { FC } from "react"
import { Skeleton } from "@/components/ui/skeleton"

const FileCardSkeleton: FC = () => {
    return (
        <div className="border border-neutral-200 dark:border-neutral-700 rounded-lg overflow-hidden bg-white dark:bg-neutral-800">
            {/* Thumbnail/Icon Area */}
            <div className="aspect-square relative bg-neutral-100 dark:bg-neutral-900 flex items-center justify-center">
                <Skeleton className="w-16 h-16" />
            </div>

            {/* File Info */}
            <div className="p-3">
                <Skeleton className="h-4 w-3/4 mb-2" />
                <div className="flex items-center justify-between">
                    <Skeleton className="h-3 w-1/4" />
                    <Skeleton className="h-4 w-12" />
                </div>
            </div>

            {/* Action Buttons */}
            <div className="px-3 pb-3 flex gap-1">
                <Skeleton className="flex-1 h-7" />
                <Skeleton className="flex-1 h-7" />
                <Skeleton className="flex-1 h-7" />
            </div>
        </div>
    )
}

export default FileCardSkeleton
