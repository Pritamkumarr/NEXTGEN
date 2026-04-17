const mongoose = require("mongoose");

const enrollmentSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Course",
      required: true
    },
    completedLessons: [
      {
        type: mongoose.Schema.Types.ObjectId
      }
    ],
    completedModules: [
      {
        type: mongoose.Schema.Types.ObjectId
      }
    ],
    status: {
      type: String,
      enum: ["in_progress", "completed"],
      default: "in_progress"
    },
    lastAccessedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
enrollmentSchema.index({ student: 1, updatedAt: -1 });

module.exports = mongoose.model("Enrollment", enrollmentSchema);
