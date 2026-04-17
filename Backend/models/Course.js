const mongoose = require("mongoose");

const lessonSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  notes: {
    type: String
  },
  videoData: {
    type: Buffer
  },
  videoContentType: {
    type: String
  }
}, { timestamps: true });

// MODULE SCHEMA
const moduleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  videoData: {
    type: Buffer
  },
  videoContentType: {
    type: String
  },
  notes: {
    type: String
  },
  course: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Course"
  },
  lessons: [lessonSchema]
}, { timestamps: true });

// COURSE SCHEMA
const courseSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String
  },
  category: {
    type: String
  },
  level: {
    type: String
  },
  frontImage: {
    type: String
  },
  modules: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Module"
    }
  ],
  instructor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  is_published: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

courseSchema.index({ instructor: 1 });
courseSchema.index({ is_published: 1 });
courseSchema.index({ is_published: 1, instructor: 1 });

moduleSchema.index({ course: 1 });

module.exports = {
  Course: mongoose.model("Course", courseSchema),
  Module: mongoose.model("Module", moduleSchema)
};
