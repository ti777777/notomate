import { FC } from "react"
import { Skeleton } from "@/components/ui/skeleton"

const ViewCardSkeleton: FC = () => {
    return (
        <div className="p-4 border dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900">
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                    <Skeleton className="w-5 h-5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                        <Skeleton className="h-5 w-3/4 mb-2" />
                        <Skeleton className="h-4 w-1/2" />
                    </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                    <Skeleton className="w-6 h-6" />
                    <Skeleton className="w-6 h-6" />
                </div>
            </div>
            <div className="mt-3 space-y-1">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
            </div>
        </div>
    )
}

export default ViewCardSkeleton
