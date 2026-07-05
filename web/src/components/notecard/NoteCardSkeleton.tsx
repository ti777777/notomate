import { FC } from "react"
import { Skeleton } from "@/components/ui/skeleton"

const NoteCardSkeleton: FC = () => {
    return (
        <div className="bg-white dark:bg-neutral-800 border sm:shadow-sm dark:border-none rounded-lg overflow-auto flex flex-col gap-2 p-4">
            <div className="flex justify-between">
                <Skeleton className="h-4 w-24" />
            </div>
            <div className="break-all w-full flex flex-col m-auto gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
            </div>
        </div>
    )
}

export default NoteCardSkeleton
