var express = require('express'),
    cfenv = require('cfenv'),
    request = require('request'),
    async = require('async'),
    GitHubApi = require("github");

var ENV = process.env,
  conductor_api = ENV.CONDUCTOR_API,
  task_name = ENV.TASK_NAME,
  deploy_org = ENV.DEPLOY_ORG,
  deploy_repo = ENV.DEPLOY_REPO;

var worker_id = "mario";
var isRunning = false;
var GH_TOKEN;
if(ENV.GH_TOKEN){
  GH_TOKEN=process.env.GH_TOKEN;
}

var repoInfo = {
    "owner": deploy_org,
    "repo": deploy_repo,
    "protected": true
}

var gh = new GitHubApi({
  // optional
  debug: true,
  protocol: 'https',
  host: 'api.github.com', // should be api.github.com for GitHub // github.my-GHE-enabled-company.com for GHE
  // pathPrefix: 'api/v3', // for some GHEs; none for GitHub
  headers: {
    'user-agent': 'Ansible-App'
  },
  Promise: require('bluebird'),
  // followRedirects: false, // default: true; there's currently an issue with non-get redirects, so allow ability to disable follow-redirects
  timeout: 5000
});


/** ****************************************** **/
/*  EXPRESS STUFF                               */
/** ****************************************** **/
// cfenv provides access to your Cloud Foundry environment
// for more info, see: https://www.npmjs.com/package/cfenv

// create a new express server
var app = express();

// get the app environment from Cloud Foundry
var appEnv = cfenv.getAppEnv();

app.get('/', (req, res) => {
  res.send('ok');
});
/** ****************************************** **/
/*  /EXPRESS STUFF                              */
/** ****************************************** **/


//Following flow: https://github.com/Netflix/conductor/issues/9

function pollForTask(callback){
    console.log("pollForTask");
    var headers = {
      'headers': {
        'Accept': 'application/json'
      }
    }

    request.get(conductor_api + "/tasks/poll/batch/" + task_name + "?timeout=100", headers, (req, res) => {
      var body, workflowInstanceId, taskId, inputData = null;
      body = JSON.parse(res.body)[0];

      if(res.statusCode != 200 || !body){
        return callback("[" + res.statusCode + "] Task not found");
      }

      //console.log(body);
      workflowInstanceId = body.workflowInstanceId;
      taskId = body.taskId;
      inputData = body.inputData;


      //json body with data
      console.log("workflowInstanceId: " + workflowInstanceId);
      console.log("taskId: " + taskId);
      console.log("inputData: " + inputData);
      if( inputData ){
        console.log("inputData (STRIGIFIED): " + JSON.stringify(inputData));
      }
      callback(null, taskId, workflowInstanceId, inputData);
//      ackTask(taskId, workflowInstanceId);
    });
}

function ackTask(task_id, workflow_instance_id, input_data, callback){
  var headers = {
    'headers': {
      'Content-Type': '*/*',
      'Accept': 'text/plain'
    }
  }
  console.log("In ackTask");
  request.post(conductor_api + "/tasks/" + task_id + "/ack?workerId=" + worker_id, headers, (req, res) => {
    var body = res.body;

    if(res.statusCode != 200 || body != "true"){
      return callback("[" + res.statusCode + "] Failed to ack");
    }

    callback(null, task_id, workflow_instance_id, input_data)
    //updateTaskStatus(task_id, workflow_instance_id, "COMPLETED")

  });
}


////////////// BEGIN ADAM CODE
function processTask(task_id, workflow_instance_id, input_data, callback){

    //Do work in here
    console.log("in process task");

    var repoInfo = constructRepoInfo();
    var payload;
    if(input_data){
      console.log("input_data (STRIGIFIED): " + JSON.stringify(input_data));
        payload = {
            releases: [input_data.build1.release_url, input_data.build2.release_url]
        };
    } else {
        payload = {
            url: ['fakie', 'also']
        };
    }

    async.waterfall([
      (next) => {getHub(GH_TOKEN, next);},
      getBranches,
      (sha, next) => { sendDeployEvent(sha, payload, next); },
      tagRelease,
      createTagReference,
      createRelease
    ], (err, res) => {
      console.log('waterfall error', err);
      console.log('=============================');
      console.dir(res);
      ///
      taskStatus = "COMPLETED";
      callback(null, task_id, workflow_instance_id, taskStatus);
    });
}


//
function constructRepoInfo(str){
  result = repoInfo;
  return(result);
}

function getHub(myAuthToken, next) {
  gh.authenticate({
    type: 'token',
    token: myAuthToken
  });
  next(null);
}

function getBranches(next){
  let options = {
    protected: true,
    per_page: 1
  };
  Object.assign(options, repoInfo);
  gh.repos.getBranches(options, (err, res) => {
    console.dir(res);
    let protectedBranch = res[0];
    if(err){
      next(err);
    } else {
      next(null, protectedBranch.commit.sha);
    }
  });
}

function sendDeployEvent(sha, payload, next){
  console.log('sendDeployEventRelease');
  //get ref from getBranches and use the protected branch
  let options = {
    ref: 'master',
    description: 'triggered by upstream deploy event',
    required_contexts: [],
    payload: payload
  };
  Object.assign(options, repoInfo);
  gh.repos.createDeployment(options, (err, res) => {
    if(err){
      next(err);
    } else {
      next(null, res.id, sha);
    }
  });
}

function tagRelease(deployId, sha, next){
  console.log('tagRelease');
  let options = {
    tag: deployId+'', // Use deployment id as tag so travis can post back to it
    message: 'Deploy this.',
    object: sha,
    type: 'commit',
    tagger: {
      name: 'adamkingit',
      email: 'rak@linux.vnet.ibm.com',
      date: new Date()
    }
  };
  Object.assign(options, repoInfo);
  gh.gitdata.createTag(options, (err, res) => {next(err, deployId, res.sha);});
}

function createTagReference(tag, sha, next){
  console.log(`createTagReference(${tag}, ${sha}, ...)`);
  let options = {
    ref: 'refs/tags/' + tag,
    sha: sha
  };
  Object.assign(options, repoInfo);
  gh.gitdata.createReference(options, (err) => {next(err, tag);});
}

function createRelease(deployId, next){
  console.log('createRelease');
  let options = {
    tag_name: deployId+'', // Use deployment id as tag so travis can post back to it
    message: 'Deploy this release.',
    name: deployId+'',
    body: 'Deploy info:'
  };
  Object.assign(options, repoInfo);
  gh.repos.createRelease(options, (err) => {next(err);});
}
////////////// END ADAM CODE


function updateTaskStatus(task_id, workflow_instance_id, task_status, callback){
    console.log("updateTaskStatus");
    var str = "";
    var headers = {
      'headers': {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      'json': {
        'workflowInstanceId': workflow_instance_id,
        'taskId': task_id,
        'status': task_status
      }
    };

    request.post(conductor_api + "/tasks", headers, (req, res) => {
      var body = res.body;
      //console.log(body);
      if(res.statusCode != 204){
        return callback("[" + res.statusCode + "] Failed to update status");
      }
      callback();

    });
}

function waterfallTasks(){
  console.log("Running waterfall");
  isRunning = true;
  async.waterfall([
    pollForTask,
    ackTask,
    processTask,
    updateTaskStatus
    ], function(error){
      if(error){
        console.log("Error: " + error);
      }
      console.log("Finished runnning, waiting (30 seconds) for next task");
      isRunning = false;
  });
}

//startWorkflow();
waterfallTasks();

var seconds = 30, time_interval = seconds * 1000;
setInterval(function() {
  if( !isRunning ){
    waterfallTasks();
  }
}, time_interval);

// start server on the specified port and binding host
app.listen(appEnv.port, '0.0.0.0', function() {
  // print a message when the server starts listening
  console.log("server starting on " + appEnv.url);
});
