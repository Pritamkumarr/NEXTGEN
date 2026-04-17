const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { Course, Module } = require("../models/Course");
const Enrollment = require("../models/Enrollment");

const uploadsDir = path.join(__dirname, "..", "uploads");
const STUDENT_CACHE_TTL_MS = 15000;
const studentDashboardCache = new Map();
const studentBrowseCache = new Map();

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const getStudentCacheKey = (studentId) => String(studentId);

const getCachedValue = (cache, key) => {
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.value;
};

const setCachedValue = (cache, key, value) => {
  cache.set(key, {
    value,
    expiresAt: Date.now() + STUDENT_CACHE_TTL_MS
  });
};

const invalidateStudentCaches = (studentId) => {
  const key = getStudentCacheKey(studentId);
  studentDashboardCache.delete(key);
  studentBrowseCache.delete(key);
};

const invalidateAllStudentCaches = () => {
  studentDashboardCache.clear();
  studentBrowseCache.clear();
};

// IMAGE STORAGE CONFIG
const imageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const imageUpload = multer({ storage: imageStorage });
const videoUpload = multer({ storage: multer.memoryStorage() });

const buildModuleVideoPath = (courseId, moduleId) =>
  `/api/courses/${courseId}/modules/${moduleId}/video`;

const buildLessonVideoPath = (courseId, moduleId, lessonId) =>
  `/api/courses/${courseId}/modules/${moduleId}/lessons/${lessonId}/video`;

const streamVideoBuffer = (req, res, videoBuffer, contentType) => {
  const total = videoBuffer.length;
  const range = req.headers.range;

  res.set("Accept-Ranges", "bytes");
  res.set("Content-Type", contentType || "video/mp4");

  if (!range) {
    res.set("Content-Length", total);
    return res.status(200).send(videoBuffer);
  }

  const matches = /bytes=(\d*)-(\d*)/.exec(range);

  if (!matches) {
    return res.status(416).set("Content-Range", `bytes */${total}`).end();
  }

  const start = matches[1] ? Number(matches[1]) : 0;
  const end = matches[2] ? Number(matches[2]) : total - 1;

  if (
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    start < 0 ||
    end >= total ||
    start > end
  ) {
    return res.status(416).set("Content-Range", `bytes */${total}`).end();
  }

  const chunk = videoBuffer.subarray(start, end + 1);

  res.status(206);
  res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.set("Content-Length", chunk.length);

  return res.send(chunk);
};

const serializeLesson = (lesson, courseId, moduleId) => {
  const { videoData, videoContentType, ...rest } = lesson;

  return {
    ...rest,
    video: videoContentType
      ? buildLessonVideoPath(courseId, moduleId, lesson._id)
      : null
  };
};

const serializeModule = (module, courseId) => {
  const {
    videoData,
    videoContentType,
    lessons = [],
    ...rest
  } = module;

  return {
    ...rest,
    video: videoContentType
      ? buildModuleVideoPath(courseId, module._id)
      : null,
    lessons: lessons.map(lesson =>
      serializeLesson(lesson, courseId, module._id)
    )
  };
};

const normalizeCourse = (course) => {
  const plain = course.toObject ? course.toObject() : course;

  return {
    ...plain,
    module_count: Array.isArray(plain.modules) ? plain.modules.length : 0,
    instructor_name: plain.instructor?.name || ""
  };
};

const calculateProgress = ({ enrollment, modules = [] }) => {
  const completedLessonSet = new Set(
    (enrollment?.completedLessons || []).map(id => id.toString())
  );

  const storedCompletedModuleSet = new Set(
    (enrollment?.completedModules || []).map(id => id.toString())
  );

  const totalModules = modules.length;
  const effectiveCompletedModuleSet = new Set(storedCompletedModuleSet);

  const completedModules = modules.reduce((count, module) => {
    const moduleId = module._id.toString();
    const lessons = Array.isArray(module.lessons) ? module.lessons : [];

    if (lessons.length === 0) {
      if (storedCompletedModuleSet.has(moduleId)) {
        effectiveCompletedModuleSet.add(moduleId);
        return count + 1;
      }

      return count;
    }

    const isModuleComplete = lessons.every(lesson =>
      completedLessonSet.has(lesson._id.toString())
    );

    if (isModuleComplete) {
      effectiveCompletedModuleSet.add(moduleId);
      return count + 1;
    }

    return count;
  }, 0);

  const status =
    totalModules > 0 && completedModules === totalModules
      ? "completed"
      : "in_progress";

  return {
    totalModules,
    completedModules,
    status,
    completedLessonIds: Array.from(completedLessonSet),
    completedModuleIds: Array.from(effectiveCompletedModuleSet)
  };
};

const buildDashboardProgress = ({ enrollment, course }) => {
  const moduleIds = (course.modules || []).map(moduleId => moduleId.toString());
  const courseModuleIdSet = new Set(moduleIds);
  const completedModules = new Set(
    (enrollment?.completedModules || [])
      .map(id => id.toString())
      .filter(id => courseModuleIdSet.has(id))
  );

  const totalModules = moduleIds.length;
  const completedModuleCount =
    enrollment?.status === "completed"
      ? totalModules
      : completedModules.size;
  const status =
    enrollment?.status === "completed" ||
    (totalModules > 0 && completedModuleCount === totalModules)
      ? "completed"
      : "in_progress";

  return {
    totalModules,
    completedModules: completedModuleCount,
    status
  };
};

const loadCourseWithModules = async (courseId) => {
  return Course.findById(courseId)
    .populate({
      path: "modules",
      select: "title notes videoContentType lessons"
    })
    .populate({
      path: "instructor",
      select: "name"
    })
    .lean();
};

const ensureStudentRole = (req, res) => {
  if (req.user?.role !== "student") {
    res.status(403).json({ message: "Student access only" });
    return false;
  }

  return true;
};

// CREATE COURSE
exports.createCourse = async (req, res) => {
  try {
    const { title, description, category, level } = req.body;

    const frontImage = req.file ? req.file.filename : null;

    const course = new Course({
      title,
      description,
      category,
      level,
      frontImage,
      instructor: req.user._id
    });

    await course.save();
    invalidateAllStudentCaches();

    res.status(201).json(course);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET INSTRUCTOR COURSES
exports.getInstructorCourses = async (req, res) => {
  try {
    const courses = await Course.find({
      instructor: req.user._id
    }).lean();

    const courseIds = courses.map(course => course._id);
    const totalEnrollments = courseIds.length === 0
      ? 0
      : await Enrollment.countDocuments({
          course: { $in: courseIds }
        });

    res.json({
      courses,
      stats: {
        total_enrollments: totalEnrollments
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET SINGLE COURSE (for CourseManage)
exports.getSingleCourse = async (req, res) => {
  try {
    const course = await loadCourseWithModules(req.params.id);

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (String(course.instructor?._id || course.instructor) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json({
      ...course,
      modules: (course.modules || []).map(module =>
        serializeModule(module, course._id.toString())
      )
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET PUBLISHED COURSES FOR STUDENTS
exports.getBrowseCourses = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const cacheKey = getStudentCacheKey(req.user._id);
    const cachedBrowse = getCachedValue(studentBrowseCache, cacheKey);

    if (cachedBrowse) {
      return res.json(cachedBrowse);
    }

    const publishedCourses = await Course.find({ is_published: true })
      .select("title description category level frontImage instructor modules")
      .populate({ path: "instructor", select: "name" })
      .populate({ path: "modules", select: "_id" })
      .lean();

    const enrollments = await Enrollment.find({
      student: req.user._id
    }).select("course").lean();

    const enrolledCourseIds = new Set(
      enrollments.map(item => item.course.toString())
    );

    const browseAll = publishedCourses
      .filter(course => !enrolledCourseIds.has(course._id.toString()))
      .map(normalizeCourse);

    setCachedValue(studentBrowseCache, cacheKey, browseAll);
    res.json(browseAll);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET PUBLIC INSTRUCTOR DIRECTORY
exports.getInstructorDirectory = async (req, res) => {
  try {
    const courses = await Course.find({ is_published: true })
      .select("title description category level frontImage modules instructor createdAt")
      .populate({ path: "instructor", select: "name email" })
      .populate({ path: "modules", select: "_id" })
      .sort({ createdAt: -1 })
      .lean();

    const instructorMap = new Map();

    courses.forEach(course => {
      const instructor = course.instructor;

      if (!instructor?._id) {
        return;
      }

      const instructorId = instructor._id.toString();

      if (!instructorMap.has(instructorId)) {
        instructorMap.set(instructorId, {
          _id: instructor._id,
          name: instructor.name || "Instructor",
          email: instructor.email || "",
          course_count: 0,
          courses: []
        });
      }

      const entry = instructorMap.get(instructorId);
      entry.courses.push(normalizeCourse(course));
      entry.course_count += 1;
    });

    res.json(Array.from(instructorMap.values()));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET PUBLIC COURSE DIRECTORY
exports.getPublicCourseDirectory = async (req, res) => {
  try {
    const courses = await Course.find({ is_published: true })
      .select("title description category level frontImage modules instructor createdAt")
      .populate({ path: "instructor", select: "name" })
      .populate({ path: "modules", select: "_id" })
      .sort({ createdAt: -1 })
      .lean();

    res.json(courses.map(normalizeCourse));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET STUDENT DASHBOARD DATA
exports.getStudentDashboard = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const cacheKey = getStudentCacheKey(req.user._id);
    const cachedDashboard = getCachedValue(studentDashboardCache, cacheKey);

    if (cachedDashboard) {
      return res.json(cachedDashboard);
    }

    const enrollments = await Enrollment.find({
      student: req.user._id
    }).sort({ updatedAt: -1 }).lean();

    const enrolledCourseIds = new Set(
      enrollments.map(item => item.course.toString())
    );
    const enrolledCourseIdList = Array.from(enrolledCourseIds);

    const enrolledCourses = enrolledCourseIdList.length === 0
      ? []
      : await Course.find({ _id: { $in: enrolledCourseIdList } })
          .select("title description category level frontImage instructor modules")
          .populate({ path: "instructor", select: "name" })
          .lean();

    const enrolledCourseMap = new Map(
      enrolledCourses.map(course => [course._id.toString(), course])
    );

    const myCourses = enrollments
      .map(enrollment => {
        const course = enrolledCourseMap.get(enrollment.course.toString());

        if (!course) {
          return null;
        }

        const progress = buildDashboardProgress({
          enrollment,
          course
        });

        return {
          ...normalizeCourse(course),
          total_units: progress.totalModules,
          completed_units: progress.completedModules,
          total_modules: progress.totalModules,
          completed_modules: progress.completedModules,
          enrollment_status: progress.status,
          enrolled_at: enrollment.createdAt,
          last_accessed_at: enrollment.lastAccessedAt
        };
      })
      .filter(Boolean);

    const completed = myCourses.filter(item => item.enrollment_status === "completed");
    const inProgress = myCourses.filter(item => item.enrollment_status === "in_progress");

    const dashboardPayload = {
      stats: {
        enrolled: myCourses.length,
        completed: completed.length,
        in_progress: inProgress.length
      },
      my_courses: myCourses,
      completed,
      in_progress: inProgress,
      browse_all: []
    };

    setCachedValue(studentDashboardCache, cacheKey, dashboardPayload);
    res.json(dashboardPayload);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ENROLL IN A COURSE
exports.enrollInCourse = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const { id } = req.params;

    const course = await Course.findById(id).select("_id is_published");

    if (!course || !course.is_published) {
      return res.status(404).json({ message: "Course not found" });
    }

    const existingEnrollment = await Enrollment.findOne({
      student: req.user._id,
      course: id
    });

    if (existingEnrollment) {
      return res.status(200).json({
        message: "Already enrolled",
        enrollment: existingEnrollment
      });
    }

    const enrollment = await Enrollment.create({
      student: req.user._id,
      course: id
    });
    invalidateStudentCaches(req.user._id);

    res.status(201).json({
      message: "Enrolled successfully",
      enrollment
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UNENROLL FROM A COURSE
exports.unenrollFromCourse = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const { id } = req.params;

    const enrollment = await Enrollment.findOneAndDelete({
      student: req.user._id,
      course: id
    });

    if (!enrollment) {
      return res.status(404).json({ message: "Enrollment not found" });
    }

    invalidateStudentCaches(req.user._id);

    res.json({ message: "Unenrolled successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET STUDENT COURSE VIEW
exports.getStudentCourse = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const { id } = req.params;

    const course = await loadCourseWithModules(id);

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const enrollment = await Enrollment.findOne({
      student: req.user._id,
      course: id
    });

    if (!enrollment) {
      return res.status(403).json({ message: "Enroll in this course first" });
    }

    const progress = calculateProgress({
      enrollment,
      modules: course.modules || []
    });

    const nextCompletedModuleIds = progress.completedModuleIds.map(String);
    const currentCompletedModuleIds = (enrollment.completedModules || []).map(id =>
      id.toString()
    );
    const currentCompletedModuleSet = new Set(currentCompletedModuleIds);

    if (
      enrollment.status !== progress.status ||
      nextCompletedModuleIds.length !== currentCompletedModuleIds.length ||
      nextCompletedModuleIds.some(id => !currentCompletedModuleSet.has(id))
    ) {
      enrollment.status = progress.status;
      enrollment.completedModules = progress.completedModuleIds;
      await enrollment.save();
    }

    res.json({
      ...course,
      modules: (course.modules || []).map(module =>
        serializeModule(module, course._id.toString())
      ),
      progress: {
        ...progress,
        enrollmentId: enrollment._id,
        enrolledAt: enrollment.createdAt,
        lastAccessedAt: enrollment.lastAccessedAt
      }
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// MARK LESSON/MODULE COMPLETE AFTER VIDEO FINISHES
exports.markContentComplete = async (req, res) => {
  try {
    if (!ensureStudentRole(req, res)) {
      return;
    }

    const { courseId } = req.params;
    const { moduleId, lessonId } = req.body;

    if (!moduleId) {
      return res.status(400).json({ message: "moduleId is required" });
    }

    const course = await Course.findById(courseId)
      .populate({ path: "modules", select: "_id lessons" })
      .lean();

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const enrollment = await Enrollment.findOne({
      student: req.user._id,
      course: courseId
    });

    if (!enrollment) {
      return res.status(403).json({ message: "Enroll in this course first" });
    }

    const targetModule = (course.modules || []).find(
      module => module._id.toString() === moduleId
    );

    if (!targetModule) {
      return res.status(404).json({ message: "Module not found" });
    }

    const update = {
      $set: { lastAccessedAt: new Date() }
    };

    if (lessonId) {
      const lessonExists = (targetModule.lessons || []).some(
        lesson => lesson._id.toString() === lessonId
      );

      if (!lessonExists) {
        return res.status(404).json({ message: "Lesson not found" });
      }

      update.$addToSet = { completedLessons: lessonId };
    } else {
      update.$addToSet = { completedModules: moduleId };
    }

    await Enrollment.updateOne({ _id: enrollment._id }, update);

    const updatedEnrollment = await Enrollment.findById(enrollment._id);

    if (lessonId) {
      const allLessonsCompleted = (targetModule.lessons || []).every(lesson =>
        (updatedEnrollment.completedLessons || []).some(
          completedLessonId => completedLessonId.toString() === lesson._id.toString()
        )
      );

      if (allLessonsCompleted) {
        await Enrollment.updateOne(
          { _id: enrollment._id },
          { $addToSet: { completedModules: moduleId } }
        );

        updatedEnrollment.completedModules = [
          ...(updatedEnrollment.completedModules || []),
          moduleId
        ];
      }
    }

    const progress = calculateProgress({
      enrollment: updatedEnrollment,
      modules: course.modules || []
    });

    updatedEnrollment.completedModules = progress.completedModuleIds;
    updatedEnrollment.status = progress.status;
    updatedEnrollment.lastAccessedAt = new Date();
    await updatedEnrollment.save();
    invalidateStudentCaches(req.user._id);

    res.json({
      message: "Progress updated",
      progress
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ADD MODULE
exports.addModule = async (req, res) => {
  try {
    const { title, notes } = req.body;
    const { courseId } = req.params;
    const course = await Course.findById(courseId);

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (String(course.instructor) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const module = new Module({
      title,
      notes,
      videoData: req.file ? req.file.buffer : null,
      videoContentType: req.file ? req.file.mimetype : null,
      course: courseId
    });

    await module.save();

    await Course.findByIdAndUpdate(courseId, {
      $push: { modules: module._id }
    });
    invalidateAllStudentCaches();

    res.status(201).json(
      serializeModule(module.toObject(), courseId)
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteCourse = async (req, res) => {
  try {
    const course = await Course.findOne({
      _id: req.params.id,
      instructor: req.user._id
    });

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    await Enrollment.deleteMany({ course: course._id });
    await Module.deleteMany({ course: course._id });
    await Course.deleteOne({ _id: course._id });
    invalidateAllStudentCaches();

    res.json({ message: "Course deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updatePublishStatus = async (req, res) => {
  try {
    const { is_published } = req.body;

    if (typeof is_published !== "boolean") {
      return res.status(400).json({
        message: "is_published must be a boolean"
      });
    }

    const course = await Course.findOneAndUpdate(
      {
        _id: req.params.id,
        instructor: req.user._id
      },
      {
        is_published
      },
      {
        new: true
      }
    );

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    invalidateAllStudentCaches();

    res.json(course);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE MODULE
exports.deleteModule = async (req, res) => {
  try {
    const { courseId, moduleId } = req.params;

    const course = await Course.findOne({
      _id: courseId,
      instructor: req.user._id
    });

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId
    });

    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    await Module.deleteOne({ _id: moduleId });

    await Enrollment.updateMany(
      { course: courseId },
      {
        $pull: {
          completedModules: moduleId,
          completedLessons: {
            $in: (module.lessons || []).map(lesson => lesson._id)
          }
        }
      }
    );

    await Course.findByIdAndUpdate(courseId, {
      $pull: { modules: moduleId }
    });
    invalidateAllStudentCaches();

    res.json({ message: "Module deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ADD LESSON
exports.addLesson = async (req, res) => {
  try {
    const { title, notes } = req.body;
    const { courseId, moduleId } = req.params;
    const course = await Course.findById(courseId);

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (String(course.instructor) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const courseHasModule = (course.modules || []).some(
      id => id.toString() === moduleId
    );

    if (!courseHasModule) {
      return res.status(404).json({ message: "Module not found" });
    }

    const module = await Module.findById(moduleId).lean();

    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    const lessonId = new mongoose.Types.ObjectId();
    const lesson = {
      _id: lessonId,
      title,
      notes,
      videoData: req.file ? req.file.buffer : null,
      videoContentType: req.file ? req.file.mimetype : null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await Module.updateOne(
      { _id: moduleId },
      {
        $set: {
          course: courseId,
          updatedAt: new Date()
        },
        $push: { lessons: lesson }
      }
    );
    invalidateAllStudentCaches();

    res.status(201).json(
      serializeLesson(
        lesson,
        courseId,
        moduleId
      )
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.streamModuleVideo = async (req, res) => {
  try {
    const { courseId, moduleId } = req.params;

    const course = await Course.findById(courseId).select("_id is_published instructor");

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (req.user?.role === "student") {
      const enrollment = await Enrollment.findOne({
        student: req.user._id,
        course: courseId
      }).select("_id");

      if (!enrollment) {
        return res.status(403).json({ message: "Not enrolled" });
      }
    }

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId
    }).select("videoData videoContentType");

    if (!module || !module.videoData) {
      return res.status(404).json({ message: "Video not found" });
    }

    return streamVideoBuffer(
      req,
      res,
      module.videoData,
      module.videoContentType
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.streamLessonVideo = async (req, res) => {
  try {
    const { courseId, moduleId, lessonId } = req.params;

    const course = await Course.findById(courseId).select("_id is_published instructor");

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    if (req.user?.role === "student") {
      const enrollment = await Enrollment.findOne({
        student: req.user._id,
        course: courseId
      }).select("_id");

      if (!enrollment) {
        return res.status(403).json({ message: "Not enrolled" });
      }
    }

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId
    }).select("lessons");

    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    const lesson = module.lessons.id(lessonId);

    if (!lesson || !lesson.videoData) {
      return res.status(404).json({ message: "Video not found" });
    }

    return streamVideoBuffer(
      req,
      res,
      lesson.videoData,
      lesson.videoContentType
    );

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE LESSON
exports.deleteLesson = async (req, res) => {
  try {
    const { courseId, moduleId, lessonId } = req.params;

    const course = await Course.findOne({
      _id: courseId,
      instructor: req.user._id
    });

    if (!course) {
      return res.status(404).json({ message: "Course not found" });
    }

    const module = await Module.findOne({
      _id: moduleId,
      course: courseId
    });

    if (!module) {
      return res.status(404).json({ message: "Module not found" });
    }

    const lesson = module.lessons.id(lessonId);

    if (!lesson) {
      return res.status(404).json({ message: "Lesson not found" });
    }

    lesson.deleteOne();
    await module.save();

    await Enrollment.updateMany(
      { course: courseId },
      { $pull: { completedLessons: lessonId } }
    );
    invalidateAllStudentCaches();

    res.json({ message: "Lesson deleted successfully" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  imageUpload,
  videoUpload,
  createCourse: exports.createCourse,
  getInstructorCourses: exports.getInstructorCourses,
  getInstructorDirectory: exports.getInstructorDirectory,
  getPublicCourseDirectory: exports.getPublicCourseDirectory,
  getSingleCourse: exports.getSingleCourse,
  getBrowseCourses: exports.getBrowseCourses,
  getStudentDashboard: exports.getStudentDashboard,
  enrollInCourse: exports.enrollInCourse,
  unenrollFromCourse: exports.unenrollFromCourse,
  getStudentCourse: exports.getStudentCourse,
  markContentComplete: exports.markContentComplete,
  addModule: exports.addModule,
  deleteCourse: exports.deleteCourse,
  updatePublishStatus: exports.updatePublishStatus,
  deleteModule: exports.deleteModule,
  addLesson: exports.addLesson,
  deleteLesson: exports.deleteLesson,
  streamModuleVideo: exports.streamModuleVideo,
  streamLessonVideo: exports.streamLessonVideo
};
