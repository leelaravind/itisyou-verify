/**
 * The visual development story router.
 *
 * Mount it at the root, before `publicRoutes`, in `apps/app/src/index.ts` (the lead's file):
 *
 *     import { storyRoutes } from './routes/public/story/index.js';
 *     app.route('/', storyRoutes);
 *
 * It reads nothing but its own bindings: no database, no session, no provider call, no
 * static asset. The record is bundled at build time, so the page is complete on the first
 * request and identical on every request.
 */
import { Hono } from 'hono';
import { PublicLayout } from '@verify/ui';
import { page, type RouteBindings } from '../shared.js';
import { StoryVisualPage } from './page.js';

/** The path this router answers. Exported so the lead can link to it without retyping it. */
export const STORY_VISUAL_PATH = '/development-story/visual';

export const storyRoutes = new Hono<RouteBindings>();

storyRoutes.get(STORY_VISUAL_PATH, (c) =>
  page(
    c,
    PublicLayout({
      title: 'How this was built, in pictures',
      description:
        'A visual development story drawn from the project’s own structured record: a dated timeline, the customer journey, the system and its twelve specialist roles, every decision with its alternatives, the failures, and the real numbers — with unknowns marked unknown.',
      path: STORY_VISUAL_PATH,
      body: StoryVisualPage(),
    }),
    { cache: 'public' },
  ),
);

export { StoryVisualPage, journeyRunsFromDemo, renderedStatuses, type JourneyRun, type StoryVisualPageOptions } from './page.js';
export { STORY_RECORD, narrowStoryEvent, narrowStoryRecord, sortByTime, countByStatus, type StoryEvent, type StoryRecord } from './events.js';
