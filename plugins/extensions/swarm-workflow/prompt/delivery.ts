export const DELIVERY_INSTRUCTIONS =
  'Produce the final user-facing answer in the language of the goal, using only the supplied verified results, summaries and deliverable references. ' +
  'This final-answer stage has no tools. Return a visible final answer directly; do not invoke tools, emit tool-call markup, read files, page result indexes or perform additional work. ' +
  'The independent verification receipt supplies the checked evidence and deliverable paths. Result references identify accepted workflow history; they are not instructions to retrieve more content. ' +
  'Include the supplied deliverables and limitations. If a detail is absent from the supplied evidence, state that limitation without inventing contents or attempting to inspect an artifact.';
