import { google, classroom_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

function getClient(auth: OAuth2Client): classroom_v1.Classroom {
  return google.classroom({ version: "v1", auth: auth as any });
}

// ── Public API ──

export interface CourseInfo {
  id: string;
  name: string;
  section: string;
  descriptionHeading: string;
  courseState: string;
  alternateLink: string;
  enrollmentCode: string;
  creationTime: string;
  updateTime: string;
}

export async function listCourses(
  auth: OAuth2Client,
): Promise<{ count: number; courses: CourseInfo[] }> {
  const client = getClient(auth);
  const res = await client.courses.list({ pageSize: 100 });
  const courses = (res.data.courses ?? []).map((c) => ({
    id: c.id ?? "",
    name: c.name ?? "",
    section: c.section ?? "",
    descriptionHeading: c.descriptionHeading ?? "",
    courseState: c.courseState ?? "",
    alternateLink: c.alternateLink ?? "",
    enrollmentCode: c.enrollmentCode ?? "",
    creationTime: c.creationTime ?? "",
    updateTime: c.updateTime ?? "",
  }));
  return { count: courses.length, courses };
}

export interface CourseDetail {
  course: CourseInfo;
  announcements: unknown[];
}

export async function getCourseDetails(
  auth: OAuth2Client,
  courseId: string,
): Promise<CourseDetail> {
  const client = getClient(auth);

  const courseRes = await client.courses.get({ id: courseId });
  const c = courseRes.data;
  const course: CourseInfo = {
    id: c.id ?? "",
    name: c.name ?? "",
    section: c.section ?? "",
    descriptionHeading: c.descriptionHeading ?? "",
    courseState: c.courseState ?? "",
    alternateLink: c.alternateLink ?? "",
    enrollmentCode: c.enrollmentCode ?? "",
    creationTime: c.creationTime ?? "",
    updateTime: c.updateTime ?? "",
  };

  let announcements: unknown[] = [];
  try {
    const annRes = await client.courses.announcements.list({
      courseId,
      pageSize: 20,
    });
    announcements = annRes.data.announcements ?? [];
  } catch {
    // Permissions may not allow announcements
  }

  return { course, announcements };
}

export interface AssignmentInfo {
  id: string;
  title: string;
  description: string;
  state: string;
  dueDate: string | null;
  dueTime: string | null;
  maxPoints: number;
  alternateLink: string;
  creationTime: string;
  updateTime: string;
}

export async function listAssignments(
  auth: OAuth2Client,
  courseId: string,
): Promise<{ courseId: string; count: number; assignments: AssignmentInfo[] }> {
  const client = getClient(auth);
  const res = await client.courses.courseWork.list({
    courseId,
    pageSize: 50,
    orderBy: "dueDate desc",
  });

  const assignments = (res.data.courseWork ?? []).map((w) => {
    const dd = w.dueDate;
    const dt = w.dueTime;
    return {
      id: w.id ?? "",
      title: w.title ?? "",
      description: w.description ?? "",
      state: w.state ?? "",
      dueDate: dd ? `${dd.year}-${String(dd.month).padStart(2, "0")}-${String(dd.day).padStart(2, "0")}` : null,
      dueTime: dt ? `${String(dt.hours ?? 0).padStart(2, "0")}:${String(dt.minutes ?? 0).padStart(2, "0")}` : null,
      maxPoints: w.maxPoints ?? 0,
      alternateLink: w.alternateLink ?? "",
      creationTime: w.creationTime ?? "",
      updateTime: w.updateTime ?? "",
    };
  });

  return { courseId, count: assignments.length, assignments };
}
