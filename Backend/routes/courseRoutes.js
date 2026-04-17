const express = require("express");
const router = express.Router();

const courseController = require("../controllers/courseController");
const authMiddleware = require("../middleware/authMiddleware");

// CREATE COURSE
router.post(
  "/",
  authMiddleware,
  courseController.imageUpload.single("frontImage"),
  courseController.createCourse
);

// GET ALL COURSES (Instructor specific)
router.get("/", authMiddleware, courseController.getInstructorCourses);

router.get(
  "/directory/instructors",
  courseController.getInstructorDirectory
);

router.get(
  "/directory/courses",
  courseController.getPublicCourseDirectory
);

router.get(
  "/student/dashboard",
  authMiddleware,
  courseController.getStudentDashboard
);

router.get(
  "/student/browse",
  authMiddleware,
  courseController.getBrowseCourses
);

router.post(
  "/:id/enroll",
  authMiddleware,
  courseController.enrollInCourse
);

router.delete(
  "/:id/enroll",
  authMiddleware,
  courseController.unenrollFromCourse
);

router.get(
  "/:id/learn",
  authMiddleware,
  courseController.getStudentCourse
);

router.patch(
  "/:courseId/progress/video-complete",
  authMiddleware,
  courseController.markContentComplete
);

router.delete("/:id", authMiddleware, courseController.deleteCourse);
router.patch("/:id/publish", authMiddleware, courseController.updatePublishStatus);

// ADD MODULE (for later CourseManage)
router.post(
  "/:courseId/modules",
  authMiddleware,
  courseController.videoUpload.single("video"),
  courseController.addModule
);

router.delete(
  "/:courseId/modules/:moduleId",
  authMiddleware,
  courseController.deleteModule
);

// ADD LESSON
router.post(
  "/:courseId/modules/:moduleId/lessons",
  authMiddleware,
  courseController.videoUpload.single("video"),
  courseController.addLesson
);

router.delete(
  "/:courseId/modules/:moduleId/lessons/:lessonId",
  authMiddleware,
  courseController.deleteLesson
);

router.get(
  "/:courseId/modules/:moduleId/video",
  courseController.streamModuleVideo
);

router.get(
  "/:courseId/modules/:moduleId/lessons/:lessonId/video",
  courseController.streamLessonVideo
);

// GET SINGLE COURSE (for CourseManage page)
router.get("/:id", authMiddleware, courseController.getSingleCourse);

module.exports = router;
