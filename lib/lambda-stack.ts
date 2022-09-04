import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cwLogs from 'aws-cdk-lib/aws-logs';

import { getLambdaDefinitions, getFunctionProps } from './config/lambda-config';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
// Types
import { CDKContext } from '../shared/types';

export class CDKLambdaBaseStack extends Stack {
  public readonly lambdaFunctions: {
    [key: string]: NodejsFunction;
  } = {};
  constructor(scope: Construct, id: string, props: StackProps, context: CDKContext) {
    super(scope, id, props);
    // dynamodb

    const ddbTable = new ddb.Table(this, 'ddbTable', {
      tableName: `${context.appName}-${context.environment}`,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'email', type: ddb.AttributeType.STRING }
    });
    ddbTable.addGlobalSecondaryIndex({
      indexName: `itemType-index`,
      partitionKey: { name: 'itemType', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL
    })
    // Lambda Role
    const lambdaRole = new iam.Role(this, 'lambdaRole', {
      roleName: `${context.appName}-lambda-role-${context.environment}`,
      description: `Lambda role for ${context.appName}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
    });

    // Attach inline policies to Lambda role
    lambdaRole.attachInlinePolicy(
      new iam.Policy(this, 'lambdaExecutionAccess', {
        policyName: 'lambdaExecutionAccess',
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: ['*'],
            actions: [
              'logs:CreateLogGroup',
              'logs:CreateLogStream',
              'logs:DescribeLogGroups',
              'logs:DescribeLogStreams',
              'logs:PutLogEvents',
            ],
          }),
        ],
      })
    );
    ddbTable.grantReadWriteData(lambdaRole);
    // Lambda Layer
    const lambdaLayer = new lambda.LayerVersion(this, 'lambdaLayer', {
      code: lambda.Code.fromAsset('shared'),
      compatibleRuntimes: [lambda.Runtime.NODEJS_14_X],
      description: `Lambda Layer for ${context.appName}`,
    });
    // api definition
    appsync.fr
    const graphqlApi = new appsync.GraphqlApi(this, 'graphqlApi', {
      name: `${context.appName}-${context.environment}`,
      schema: appsync.Schema.fromAsset('lib/schema.graphql'),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.API_KEY
        }
      }
    })
    // Get Lambda definitions
    const lambdaDefinitions = getLambdaDefinitions(context);

    // Loop through the definitions and create lambda functions
    for (const lambdaDefinition of lambdaDefinitions) {
      // Get function props based on lambda definition
      let functionProps = getFunctionProps(lambdaDefinition, lambdaRole, lambdaLayer, context);

      // Lambda Function
      const lambdaFunction = new NodejsFunction(this, `${lambdaDefinition.name}-function`, functionProps);
      this.lambdaFunctions[lambdaDefinition.name] = lambdaFunction;
 

      //data source & resolvers
      if(lambdaDefinition.name === 'get-users'){
        const lambdaDS = graphqlApi.addLambdaDataSource('getUsersDS', lambdaFunction);
        lambdaDS.createResolver({ typeName: 'Query', fieldName: 'getUsers'});
      }
      if(lambdaDefinition.name === 'add-user'){
        const lambdaDS = graphqlApi.addLambdaDataSource('addUserDS', lambdaFunction);
        lambdaDS.createResolver({ typeName: 'Mutation', fieldName: 'addUser'});
      }
      if(lambdaDefinition.name === 'delete-user'){
        const lambdaDS = graphqlApi.addLambdaDataSource('deleteUserDS', lambdaFunction);
        lambdaDS.createResolver({ typeName: 'Mutation', fieldName: 'deleteUser'});
      }
      // Create corresponding Log Group with one month retention
      new cwLogs.LogGroup(this, `fn-${lambdaDefinition.name}-log-group`, {
        logGroupName: `/aws/lambda/${context.appName}-${lambdaDefinition.name}-${context.environment}`,
        retention: cwLogs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    }


  }
}