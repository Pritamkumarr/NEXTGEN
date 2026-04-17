const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Enrollment = require("../models/Enrollment");
const { Course } = require("../models/Course");

const PROJECT_CONTEXT = `
You are the AI assistant for the NextGen e-learning platform.
Only use information provided in this prompt and never claim access to hidden data.
If data is user-specific, only discuss the current authenticated user's own records.
Do not invent unavailable features.
When the user asks for advice or recommendations, reason over the available NextGen course data and the user's own learning data, then suggest suitable options with a brief reason.
If the user greets you or asks casual small-talk like what you are doing, reply naturally as the NextGen assistant and gently steer toward how you can help on NextGen.
If the user asks something unrelated to NextGen and it is not simple small-talk, politely say you can only help with NextGen learning-platform questions.
If the user asks a nonsense, unclear, or no-logic question, do not guess; ask them to rephrase clearly.
Keep answers concise, practical, and product-focused.
`.trim();

const PRIVACY_SUMMARY = [
  "NextGen stores basic account details like name, email, and role for sign-in and dashboard access.",
  "Learning activity such as enrollments and completion progress is stored to support student learning and instructor insights.",
  "Uploaded content and usage data are used to operate, improve, and secure the platform.",
  "This is a simple policy summary; refer to /legal#privacy for the full in-app legal page."
];

const TERMS_SUMMARY = [
  "Users should keep credentials secure and use the platform lawfully and respectfully.",
  "Instructors should upload content they have rights to share.",
  "Students should use course materials for intended learning purposes.",
  "NextGen may moderate misuse or restrict access for policy violations.",
  "This is a simplified terms summary; refer to /legal#terms for the full in-app legal page."
];

const extractText = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => part?.text || "")
    .join("\n")
    .trim();
};

const normalizeQuestion = (value) => String(value || "").trim().toLowerCase();

const isLikelyNonsenseQuestion = (question) => {
  const normalized = normalizeQuestion(question);
  const compact = normalized.replace(/\s+/g, "");

  if (compact.length < 3) {
    return true;
  }

  if (!/[a-z0-9]/i.test(compact)) {
    return true;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const longGibberishWord = words.some(
    (word) => word.length >= 12 && !/[aeiou]/i.test(word)
  );
  const repeatedChars = /(.)\1{5,}/i.test(compact);

  return longGibberishWord || repeatedChars;
};

const isNextGenRelatedQuestion = (question) => {
  const q = normalizeQuestion(question);

  return /nextgen|course|courses|lesson|lessons|module|modules|student|students|instructor|instructors|teacher|teachers|enroll|enrolled|enrollment|learn|learning|progress|complete|completed|dashboard|profile|account|login|sign in|signup|register|password|privacy|terms|policy|certificate|video|upload|publish/.test(
    q
  );
};

const isSmallTalkQuestion = (question) => {
  const q = normalizeQuestion(question);

  return /^(hi|hii|hello|hey|thanks|thank you|ok|okay)\b/.test(q) ||
    /how are you|what are you doing|who are you|what can you do|help me/.test(q);
};

const getSmallTalkFallbackAnswer = (question) => {
  const q = normalizeQuestion(question);

  if (/who are you|what are you/.test(q)) {
    return "I’m your NextGen AI assistant. I can help you explore courses, check your enrollments or progress, and guide instructors with course and student-related questions.";
  }

  if (/how are you/.test(q)) {
    return "I’m doing well and ready to help you with NextGen. You can ask about courses, enrollments, your progress, or instructor tools.";
  }

  if (/what are you doing/.test(q)) {
    return "I’m here helping users with NextGen course and learning questions. If you want, I can help you find a course, check your progress, or explain how enrollment works.";
  }

  return "Hello! I’m your NextGen AI assistant. Ask me about courses, enrollments, learning progress, instructors, or how this platform works.";
};

const tryAttachUserFromToken = async (req) => {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    req.user = null;
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("_id name email role");
    req.user = user || null;
  } catch (_error) {
    req.user = null;
  }
};

const formatBulletList = (title, lines = []) => {
  if (!lines.length) {
    return `${title}\n- None found.`;
  }

  return `${title}\n${lines.map((line) => `- ${line}`).join("\n")}`;
};

const classifyIntent = (question) => {
  const q = normalizeQuestion(question);

  const hasCoursesWord = /course|courses/.test(q);
  const hasInstructorWord = /instructor|instructors|teacher|teachers/.test(q);
  const asksList = /list|show|what are|which|give me|display|how many|number of|count/.test(q);
  const asksMine = /\bmy\b|\bi\b|me\b/.test(q);
  const asksProfile = /profile|account|name|email|who am i/.test(q);
  const asksCreatedCourses = /created|uploaded|published|draft/.test(q) && hasCoursesWord;
  const asksCompletedCourses = /completed|finished/.test(q) && hasCoursesWord;
  const asksEnrolledCourses = /enrolled|joined|registered|learning|my courses/.test(q) && hasCoursesWord;
  const asksCourseRecommendation = /should|recommend|suggest|best|good|suitable|which course should|what course should|which courses should|what courses should/.test(q) &&
    /course|courses|enroll|learn|study/.test(q);
  const asksProgress = /progress|status|last accessed|lessons completed|modules completed/.test(q);
  const asksInstructorStudents = /student|students|learners|enrolled|enrollments/.test(q) &&
    /how many|number of|count|my course|my courses|created|uploaded|published/.test(q);

  if (/privacy|data policy/.test(q)) {
    return "privacy";
  }

  if (/terms|conditions|rules/.test(q)) {
    return "terms";
  }

  if (asksMine && asksCreatedCourses) {
    return "my_created_courses";
  }

  if (asksMine && asksCompletedCourses) {
    return "my_completed_courses";
  }

  if (asksMine && asksInstructorStudents) {
    return "my_instructor_students";
  }

  if (asksMine && asksEnrolledCourses) {
    return "my_enrolled_courses";
  }

  if (asksMine && asksProgress) {
    return "my_course_progress";
  }

  if (asksMine && asksProfile) {
    return "my_profile";
  }

  if (asksCourseRecommendation) {
    return "course_recommendation";
  }

  if (hasInstructorWord && asksList) {
    return "list_instructors";
  }

  if (hasCoursesWord && asksList) {
    return "list_courses";
  }

  return "general";
};

const getPublicCourses = async () => {
  const courses = await Course.find({ is_published: true })
    .select("title category level instructor")
    .populate({ path: "instructor", select: "name" })
    .sort({ createdAt: -1 })
    .limit(25)
    .lean();

  return courses.map((course) => {
    const levelText = course.level ? ` (${course.level})` : "";
    const categoryText = course.category ? ` - ${course.category}` : "";
    const instructorText = course.instructor?.name
      ? ` by ${course.instructor.name}`
      : "";

    return `${course.title}${levelText}${categoryText}${instructorText}`;
  });
};

const getPublicInstructors = async () => {
  const courses = await Course.find({ is_published: true })
    .select("instructor")
    .populate({ path: "instructor", select: "name email" })
    .lean();

  const deduped = new Map();

  courses.forEach((course) => {
    const instructor = course.instructor;

    if (!instructor?._id) {
      return;
    }

    const key = instructor._id.toString();

    if (!deduped.has(key)) {
      deduped.set(key, {
        name: instructor.name || "Instructor",
        email: instructor.email || ""
      });
    }
  });

  return Array.from(deduped.values())
    .slice(0, 25)
    .map((item) => (item.email ? `${item.name} (${item.email})` : item.name));
};

const getMyEnrolledCourses = async (user) => {
  if (!user) {
    return {
      error: "Please sign in to view your enrolled courses."
    };
  }

  if (user.role !== "student") {
    return {
      error: "Enrolled course details are available for student accounts only."
    };
  }

  const enrollments = await Enrollment.find({ student: user._id })
    .sort({ updatedAt: -1 })
    .populate({
      path: "course",
      select: "title category level instructor",
      populate: { path: "instructor", select: "name" }
    })
    .lean();

  const lines = enrollments
    .map((enrollment) => {
      const course = enrollment.course;

      if (!course?._id) {
        return null;
      }

      const levelText = course.level ? ` (${course.level})` : "";
      const categoryText = course.category ? ` - ${course.category}` : "";
      const statusText = enrollment.status ? ` [${enrollment.status}]` : "";
      const instructorText = course.instructor?.name
        ? ` by ${course.instructor.name}`
        : "";

      return `${course.title}${levelText}${categoryText}${instructorText}${statusText}`;
    })
    .filter(Boolean);

  const completedLines = [];
  const inProgressLines = [];
  const progressLines = [];

  enrollments.forEach((enrollment) => {
    const course = enrollment.course;

    if (!course?._id) {
      return;
    }

    const title = course.title || "Untitled Course";
    const completedLessonCount = enrollment.completedLessons?.length || 0;
    const completedModuleCount = enrollment.completedModules?.length || 0;
    const lastAccessed = enrollment.lastAccessedAt
      ? new Date(enrollment.lastAccessedAt).toDateString()
      : "Not available";

    progressLines.push(
      `${title}: ${completedLessonCount} lessons completed, ${completedModuleCount} modules completed, status ${enrollment.status || "in_progress"}, last accessed ${lastAccessed}`
    );

    if (enrollment.status === "completed") {
      completedLines.push(title);
    } else {
      inProgressLines.push(title);
    }
  });

  return {
    lines,
    completedLines,
    inProgressLines,
    progressLines,
    totalCount: enrollments.length,
    completedCount: completedLines.length,
    inProgressCount: inProgressLines.length
  };
};

const getMyInstructorCourses = async (user) => {
  if (!user) {
    return {
      error: "Please sign in to view your courses."
    };
  }

  if (user.role !== "instructor") {
    return {
      error: "Your own course list is available for instructor accounts only."
    };
  }

  const courses = await Course.find({ instructor: user._id })
    .select("title category level is_published")
    .sort({ createdAt: -1 })
    .lean();

  const courseIds = courses.map((course) => course._id);
  const enrollmentStats = await Enrollment.aggregate([
    {
      $match: {
        course: { $in: courseIds }
      }
    },
    {
      $group: {
        _id: "$course",
        studentsCount: { $sum: 1 },
        completedCount: {
          $sum: {
            $cond: [{ $eq: ["$status", "completed"] }, 1, 0]
          }
        }
      }
    }
  ]);

  const statsByCourse = new Map(
    enrollmentStats.map((item) => [
      item._id.toString(),
      {
        studentsCount: item.studentsCount || 0,
        completedCount: item.completedCount || 0
      }
    ])
  );

  const lines = courses.map((course) => {
    const stats = statsByCourse.get(course._id.toString()) || {
      studentsCount: 0,
      completedCount: 0
    };
    const levelText = course.level ? ` (${course.level})` : "";
    const categoryText = course.category ? ` - ${course.category}` : "";
    const publishText = course.is_published ? " [published]" : " [draft]";
    return `${course.title}${levelText}${categoryText}${publishText} - ${stats.studentsCount} enrolled student(s), ${stats.completedCount} completion(s)`;
  });

  const publishedCount = courses.filter((course) => course.is_published).length;
  const draftCount = courses.length - publishedCount;
  const totalStudents = enrollmentStats.reduce(
    (sum, item) => sum + (item.studentsCount || 0),
    0
  );

  return {
    lines,
    totalCourses: courses.length,
    publishedCount,
    draftCount,
    totalStudents
  };
};

const buildStudentAccountAnswer = (user, studentData) => {
  const sections = [
    `Student Profile:`,
    `- Name: ${user.name}`,
    `- Email: ${user.email}`,
    `- Total enrolled courses: ${studentData.totalCount}`,
    `- Completed courses: ${studentData.completedCount}`,
    `- In-progress courses: ${studentData.inProgressCount}`,
    "",
    formatBulletList("Your Enrolled Courses:", studentData.lines),
    "",
    formatBulletList("Completed Courses:", studentData.completedLines),
    "",
    formatBulletList("In-Progress Courses:", studentData.inProgressLines),
    "",
    formatBulletList("Progress Details:", studentData.progressLines)
  ];

  return sections.join("\n").trim();
};

const buildInstructorAccountAnswer = (user, instructorData) => {
  const sections = [
    `Instructor Profile:`,
    `- Name: ${user.name}`,
    `- Email: ${user.email}`,
    `- Uploaded courses: ${instructorData.totalCourses}`,
    `- Published courses: ${instructorData.publishedCount}`,
    `- Draft courses: ${instructorData.draftCount}`,
    `- Total student enrollments across your courses: ${instructorData.totalStudents}`,
    "",
    formatBulletList("Your Uploaded Courses:", instructorData.lines)
  ];

  return sections.join("\n").trim();
};

const buildAssistantContext = async (user) => {
  const contextLines = [
    formatBulletList("Published NextGen courses", await getPublicCourses()),
    formatBulletList("NextGen instructors", await getPublicInstructors())
  ];

  if (!user) {
    contextLines.push("Current user is a guest and not signed in.");
    contextLines.push("Guests should be guided to sign in for account-specific course, progress, or profile details.");
    contextLines.push("Legal page: /legal with #privacy and #terms sections.");
    return contextLines.join("\n\n");
  }

  contextLines.push(`Current user name: ${user.name}`);
  contextLines.push(`Current user email: ${user.email}`);
  contextLines.push(`Current user role: ${user.role}`);

  if (user.role === "student") {
    const studentData = await getMyEnrolledCourses(user);
    contextLines.push(`Student total enrolled courses: ${studentData.totalCount}`);
    contextLines.push(`Student completed courses count: ${studentData.completedCount}`);
    contextLines.push(`Student in-progress courses count: ${studentData.inProgressCount}`);
    contextLines.push(formatBulletList("Student enrolled courses", studentData.lines));
    contextLines.push(formatBulletList("Student completed courses", studentData.completedLines));
    contextLines.push(formatBulletList("Student in-progress courses", studentData.inProgressLines));
    contextLines.push(formatBulletList("Student progress details", studentData.progressLines));
    contextLines.push("If this student asks instructor-only questions like created/uploaded courses or students enrolled in their own course, clearly explain they are logged in as a student, not an instructor.");
  }

  if (user.role === "instructor") {
    const instructorData = await getMyInstructorCourses(user);
    contextLines.push(`Instructor uploaded courses count: ${instructorData.totalCourses}`);
    contextLines.push(`Instructor published courses count: ${instructorData.publishedCount}`);
    contextLines.push(`Instructor draft courses count: ${instructorData.draftCount}`);
    contextLines.push(`Total student enrollments across instructor courses: ${instructorData.totalStudents}`);
    contextLines.push(formatBulletList("Instructor uploaded courses and enrollments", instructorData.lines));
    contextLines.push("If this instructor asks student-only questions like enrolled/completed learning courses as a student, clearly explain they are logged in as an instructor, not a student.");
  }

  contextLines.push("Legal page: /legal with #privacy and #terms sections.");
  return contextLines.join("\n\n");
};

const roleMismatchAnswer = (expectedRole, currentRole) => {
  if (!currentRole) {
    return "Please sign in first so I can answer using your account data.";
  }

  const expectedArticle = /^[aeiou]/i.test(expectedRole) ? "an" : "a";
  return `You are logged in as a ${currentRole}, not as ${expectedArticle} ${expectedRole}.`;
};

const callGeminiFallback = async ({ question, user, safeContext }) => {
  if (!process.env.GEMINI_API_KEY) {
    return "";
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt = `
${PROJECT_CONTEXT}

Current user:
- Authenticated: ${Boolean(user)}
- Role: ${user?.role || "guest"}
- Name: ${user?.name || "Guest"}

Allowed context:
${safeContext}

User question:
${question}

Answering rules:
- First understand the user's meaning and intent from the full sentence, not by matching isolated keywords.
- Answer like a real conversational AI assistant, but stay grounded in the provided NextGen context and do not invent database records.
- Stay strictly focused on NextGen platform, course, student, instructor, enrollment, progress, account, and policy questions.
- If the user greets you or asks casual small-talk, answer warmly in one or two lines as the NextGen assistant, then briefly mention what you can help with on NextGen.
- If the user question is unrelated to NextGen and is not casual small-talk, reply: "I can only help with NextGen platform questions like courses, enrollments, instructor tools, dashboards, privacy, and terms."
- If the question is unclear or nonsensical, ask the user to rephrase it clearly in one short sentence.
- If the question is valid and NextGen-related, answer naturally and helpfully using only the allowed context above.
`.trim();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 350
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Gemini API error:", data);
    return "";
  }

  return extractText(data);
};

const getLocalFallbackAnswer = async ({ question, user }) => {
  const q = normalizeQuestion(question);
  const intent = classifyIntent(question);

  if (/how\s+do\s+i\s+enroll|how\s+to\s+enroll|enroll\s+in\s+a\s+course/.test(q)) {
    if (!user) {
      return "To enroll in a course on NextGen, first sign in as a student, open a course from the Courses page, and click Enroll. After that, the course should appear in your student dashboard.";
    }

    if (user.role !== "student") {
      return roleMismatchAnswer("student", user.role);
    }

    return "To enroll in a course, open a course from the Courses page or your student browse section, then click Enroll. Once enrolled, you can access it from your student dashboard.";
  }

  if (intent === "privacy") {
    return formatBulletList("Privacy Policy Summary:", PRIVACY_SUMMARY);
  }

  if (intent === "terms") {
    return formatBulletList("Terms Summary:", TERMS_SUMMARY);
  }

  if (intent === "list_courses") {
    return formatBulletList("Published Courses:", await getPublicCourses());
  }

  if (intent === "list_instructors") {
    return formatBulletList("Instructors:", await getPublicInstructors());
  }

  if (intent === "my_enrolled_courses") {
    if (user?.role !== "student") {
      return roleMismatchAnswer("student", user?.role);
    }

    const studentData = await getMyEnrolledCourses(user);
    return studentData.error || formatBulletList("Your Enrolled Courses:", studentData.lines);
  }

  if (intent === "my_completed_courses") {
    if (user?.role !== "student") {
      return roleMismatchAnswer("student", user?.role);
    }

    const studentData = await getMyEnrolledCourses(user);
    return studentData.error || formatBulletList("Your Completed Courses:", studentData.completedLines);
  }

  if (intent === "my_course_progress") {
    if (user?.role !== "student") {
      return roleMismatchAnswer("student", user?.role);
    }

    const studentData = await getMyEnrolledCourses(user);
    return studentData.error || formatBulletList("Your Course Progress:", studentData.progressLines);
  }

  if (intent === "my_created_courses") {
    if (user?.role !== "instructor") {
      return roleMismatchAnswer("instructor", user?.role);
    }

    const instructorData = await getMyInstructorCourses(user);
    return instructorData.error || formatBulletList("Your Created Courses:", instructorData.lines);
  }

  if (intent === "my_instructor_students") {
    if (user?.role !== "instructor") {
      return roleMismatchAnswer("instructor", user?.role);
    }

    const instructorData = await getMyInstructorCourses(user);

    if (instructorData.error) {
      return instructorData.error;
    }

    return [
      `Total student enrollments across your courses: ${instructorData.totalStudents}`,
      "",
      formatBulletList("Course-wise Enrollment:", instructorData.lines)
    ].join("\n");
  }

  if (intent === "my_profile") {
    if (!user) {
      return "Please sign in first so I can answer using your account data.";
    }

    if (user.role === "instructor") {
      const instructorData = await getMyInstructorCourses(user);

      return [
        "Instructor Profile:",
        `- Name: ${user.name}`,
        `- Email: ${user.email}`,
        `- Uploaded courses: ${instructorData.totalCourses}`,
        `- Published courses: ${instructorData.publishedCount}`,
        `- Draft courses: ${instructorData.draftCount}`
      ].join("\n");
    }

    const studentData = await getMyEnrolledCourses(user);

    return [
      "Student Profile:",
      `- Name: ${user.name}`,
      `- Email: ${user.email}`,
      `- Total enrolled courses: ${studentData.totalCount}`,
      `- Completed courses: ${studentData.completedCount}`,
      `- In-progress courses: ${studentData.inProgressCount}`
    ].join("\n");
  }

  return "";
};

exports.askProjectAssistant = async (req, res) => {
  try {
    const { question } = req.body || {};

    if (!question || !String(question).trim()) {
      return res.status(400).json({ message: "Question is required" });
    }

    await tryAttachUserFromToken(req);
    const user = req.user;
    const trimmedQuestion = String(question).trim();

    if (isLikelyNonsenseQuestion(trimmedQuestion)) {
      return res.json({
        answer:
          "Your question looks unclear. Please rephrase it with a proper NextGen-related question about courses, enrollments, progress, or instructor tools."
      });
    }

    const aiAnswer = await callGeminiFallback({
      question: trimmedQuestion,
      user,
      safeContext: await buildAssistantContext(user)
    });

    if (aiAnswer) {
      return res.json({ answer: aiAnswer });
    }

    if (isSmallTalkQuestion(trimmedQuestion)) {
      return res.json({
        answer: getSmallTalkFallbackAnswer(trimmedQuestion)
      });
    }

    const localFallbackAnswer = await getLocalFallbackAnswer({
      question: trimmedQuestion,
      user
    });

    if (localFallbackAnswer) {
      return res.json({ answer: localFallbackAnswer });
    }

    return res.json({
      answer: isNextGenRelatedQuestion(trimmedQuestion)
        ? "I can help with NextGen platform questions like courses, instructors, enrollments, privacy policy, and terms. Try asking: 'List my enrolled courses' or 'List instructors'."
        : "I can only help with NextGen platform questions like courses, enrollments, instructor tools, dashboards, privacy, and terms."
    });
  } catch (error) {
    return res.status(500).json({
      message: error.message || "Failed to get assistant response"
    });
  }
};
