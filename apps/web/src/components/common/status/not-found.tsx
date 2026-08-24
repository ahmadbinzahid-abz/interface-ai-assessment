import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"

/**
 * A declared "it is not there" answer.
 *
 * Visually distinct from `ConnectionError` on purpose: the server answered, and
 * the answer was *no such thing*. Painting that as a failure would teach the
 * operator to distrust a system that is working — the same mistake, one layer
 * up, that treating a business outcome as an error makes in the engine.
 */
export function NotFound({
  title,
  description,
}: {
  readonly title: string
  readonly description: string
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
