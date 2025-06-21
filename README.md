# MCP Workflow Orchestration Server 🚀

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol SDK](https://img.shields.io/badge/MCP%20SDK-1.12.1-green.svg)](https://github.com/modelcontextprotocol/typescript-sdk)
[![MCP Spec Version](https://img.shields.io/badge/MCP%20Spec-2025--03--26-lightgrey.svg)](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-03-26/changelog.mdx)
[![Version](https://img.shields.io/badge/Version-1.0.0-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Active-green.svg)](https://github.com/cyanheads/workflows-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/workflows-mcp-server?style=social)](https://github.com/cyanheads/workflows-mcp-server)

This repository contains an MCP (Model Context Protocol) server designed for workflow orchestration. It allows a Large Language Model (LLM) to discover, understand, and execute complex, multi-step workflows defined in simple YAML files.

A key feature of this system is the dynamic injection of **global instructions**, which provide high-level, consistent guidance to the LLM on how to execute the workflows, ensuring an up-to-date operational strategy without modifying individual workflow files.

## 📋 Table of Contents

- [✨ Core Concepts](#-core-concepts)
- [🏁 Quick Start](#-quick-start)
- [📂 Workflow YAML Structure](#-workflow-yaml-structure)
- [🛠️ Tool Specifications](#️-tool-specifications)
- [⚙️ System Behavior: Global Instructions](#️-system-behavior-global-instruction-injection)
- [🧩 Extending the Server](#-extending-the-server)
- [📜 License](#-license)

## ✨ Core Concepts

- **Workflow:** A predefined sequence of steps defined in a `.yaml` file. Each step specifies an action to be performed by a tool on a designated MCP server.
- **YAML Structure:** A human-readable format for defining workflow metadata and the sequence of execution steps.
- **Tools:** The functions exposed to the LLM, serving as the primary interface for interacting with the workflow system.
- **Global Instructions:** A centrally-managed set of directives that are dynamically injected into every workflow definition upon request, providing consistent, high-level guidance on execution strategy.

## 🏁 Quick Start

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/cyanheads/workflows-mcp-server.git
    cd workflows-mcp-server
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Build the project:**

    ```bash
    npm run build
    ```

4.  **Run the Server:**
    - **Via Stdio (for integration with an MCP Host):**
      ```bash
      npm run start:stdio
      ```
    - **Via HTTP (for network-based access):**
      ```bash
      npm run start:http
      ```

## 📂 Workflow YAML Structure

Each workflow is defined in its own `.yaml` file within the `workflows-yaml/` directory. The structure provides rich metadata for discovery and a clear, ordered list of steps for execution.

**Note:** The `instructions` field is not manually added to individual files; it is injected at runtime by the server.

### Full YAML Example (`workflows-yaml/example.yaml`)

```yaml
# The user-friendly name of the workflow. Used for display and selection.
name: "Process and Archive New User Images"

# Semantic versioning for the workflow to track changes and ensure compatibility.
version: "1.2.0"

# A brief, clear description of what the workflow accomplishes.
description: "Resizes an input image, applies a standard watermark, and uploads the final result to a designated cloud storage archive."

# The author or team responsible for creating the workflow.
author: "Media Processing Team"

# The date the workflow was initially created. Format: YYYY-MM-DD
created_date: "2025-06-10"

# The date the workflow was last modified. Format: YYYY-MM-DD
last_updated_date: "2025-06-13"

# A broad category for grouping similar workflows.
category: "Image Processing"

# A list of specific tags for fine-grained filtering and discovery.
tags:
  - "resize"
  - "watermark"
  - "s3"
  - "archival"

# The sequence of steps to be executed in order.
steps:
  - # Step 1: Resize the input image
    server: "image_processor_server_v2"
    tool: "image_magick_tool"
    action: "resize"
    params:
      input_file: "{{input.image_path}}" # Placeholder for dynamic input
      output_file: "resized_temp.jpg"
      width: 1024
      height: 1024
      maintain_aspect_ratio: true

  - # Step 2: Apply a watermark
    server: "image_processor_server_v2"
    tool: "image_magick_tool"
    action: "overlay"
    params:
      base_image: "resized_temp.jpg"
      overlay_image: "/assets/standard_watermark.png"
      output_file: "final_watermarked.jpg"
      position: "bottom_right"
      margin: 20

  - # Step 3: Upload to cloud storage
    server: "cloud_services_server"
    tool: "s3_storage_tool"
    action: "upload"
    params:
      source_file: "final_watermarked.jpg"
      destination_bucket: "company-archival-bucket"
      destination_path: "user_images/{{user.id}}/"
```

## 🛠️ Tool Specifications

### 1. `workflow_return_list`

- **Description:** Retrieves a list of available workflows, providing key metadata for each. This tool allows for discovery and filtering based on categories and tags.
- **Input Parameters:**
  - `category` (string, optional): Filters the list to workflows within a specific category.
  - `tags` (list of strings, optional): Filters the list to workflows that have **all** of the specified tags.
- **Output:** A JSON array of objects, where each object represents a workflow and contains its core metadata.

### 2. `workflow_get_instructions`

- **Description:** Retrieves the complete, detailed definition for a single, specified workflow, including the dynamically injected global instructions.
- **Input Parameters:**
  - `name` (string, required): The exact name of the workflow to retrieve.
  - `version` (string, optional): The specific version to retrieve. If omitted, the latest version is returned.
- **Output:** The full JSON representation of the requested workflow, with the `instructions` field prepended.

## ⚙️ System Behavior: Global Instruction Injection

The server has a critical responsibility regarding the `instructions` field.

- **Central Source:** The server maintains a single, global source for the instructions (e.g., a `.txt` or `.md` file).
- **Dynamic Injection:** On every call to `workflow_get_instructions`, the server reads the content of the global instructions file.
- **Response Merging:** The server parses the requested workflow YAML and merges the global instructions into the final JSON object returned to the client.

This behavior ensures that any update to the global instructions is immediately propagated to the LLM without requiring modifications to individual workflow files.

## 🧩 Extending the Server

For detailed guidance on how to add your own custom Tools and Resources, please see the [Server Extension Guide](src/mcp-server/README.md).

## 📜 License

This project is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with ❤️ and the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
